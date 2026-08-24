"""Clients for everything Barnaby talks to.

STREAMING STRATEGY — where the wins actually are.

The OpenAI transcription endpoint takes a complete file, so there is no true
streaming ASR to be had. That is fine, because it is not the bottleneck. For a
3-second utterance the audio is ~96 KB and Whisper large-v3-turbo on an M3 Ultra
runs far faster than real time. The wins are downstream:

  1. TIER 0 SKIPS THE LLM ENTIRELY. Home Assistant's Assist agent matches device
     commands locally in ~50 ms. Most kitchen traffic never reaches a model.

  2. LLM TOKENS ARE STREAMED and split into sentences on the fly.

  3. TTS IS PIPELINED PER SENTENCE. Sentence one is synthesised and playing
     while sentence three is still being generated. This is the single largest
     perceived-latency win in the whole system — it decouples time-to-first-audio
     from response length, so a long answer starts as fast as a short one.

  4. THE FIRST SENTENCE IS CUT SHORT ON PURPOSE. We flush at the first clause
     boundary past a low character count, so audio starts sooner. Later
     sentences use normal boundaries.
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from dataclasses import dataclass
from typing import AsyncIterator, Callable

import httpx
import numpy as np
import soundfile as sf

log = logging.getLogger("barnaby.clients")


def wav_bytes(audio: np.ndarray, rate: int = 16_000) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class ASR:
    """Rapid-MLX / OpenAI-compatible /v1/audio/transcriptions."""

    def __init__(self, base_url: str, model: str, language: str = "en",
                 timeout: float = 20.0):
        self.url = f"{base_url.rstrip('/')}/audio/transcriptions"
        self.model = model
        self.language = language
        self._http = httpx.AsyncClient(timeout=timeout)

    async def transcribe(self, audio: np.ndarray) -> str:
        files = {"file": ("turn.wav", wav_bytes(audio), "audio/wav")}
        data = {"model": self.model, "language": self.language,
                "response_format": "json"}
        r = await self._http.post(self.url, files=files, data=data)
        r.raise_for_status()
        return (r.json().get("text") or "").strip()

    async def aclose(self) -> None:
        await self._http.aclose()


@dataclass
class AssistResult:
    handled: bool
    speech: str


class HomeAssistant:
    """Tier 0. HA's built-in Assist agent already knows every entity, area and
    alias in the house, matches locally, and works with the internet down.
    Writing our own intent classifier would be strictly worse."""

    def __init__(self, base_url: str, token: str, agent_id: str,
                 area: str, timeout: float = 4.0):
        self.url = f"{base_url.rstrip('/')}/api/conversation/process"
        self.agent_id = agent_id
        self.area = area
        self._http = httpx.AsyncClient(
            timeout=timeout, headers={"Authorization": f"Bearer {token}"})

    async def process(self, text: str) -> AssistResult:
        payload = {"text": text, "agent_id": self.agent_id, "language": "en"}
        try:
            r = await self._http.post(self.url, json=payload)
            r.raise_for_status()
        except httpx.HTTPError as e:
            log.warning("HA unreachable: %s", e)
            raise
        body = r.json().get("response", {})
        speech = (body.get("speech", {}).get("plain", {}).get("speech") or "").strip()
        kind = body.get("response_type")
        # 'error' with code 'no_intent_match' means Assist did not understand,
        # which is our signal to escalate — not a failure.
        handled = kind != "error"
        return AssistResult(handled=handled, speech=speech)

    async def aclose(self) -> None:
        await self._http.aclose()


# Split on sentence enders, but not on decimals or common abbreviations.
_SENTENCE = re.compile(r"(?<![A-Z0-9])[.!?]['\")\]]?(?=\s|$)")
_CLAUSE = re.compile(r"[,;:]['\")\]]?(?=\s)")


class LLM:
    """Streaming chat completions. Yields sentences, not tokens, because a
    sentence is the unit TTS can start speaking."""

    def __init__(self, base_url: str, model: str, api_key: str = "not-needed",
                 max_tokens: int = 400, temperature: float = 0.4,
                 timeout: float = 60.0, no_think: bool = True):
        self.url = f"{base_url.rstrip('/')}/chat/completions"
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.no_think = no_think
        self._http = httpx.AsyncClient(
            timeout=timeout, headers={"Authorization": f"Bearer {api_key}"})

    async def stream_sentences(
        self, messages: list[dict], first_flush_chars: int = 24,
        on_first_token: Callable[[], None] | None = None,
        on_tool: Callable[[str, list[str]], None] | None = None,
    ) -> AsyncIterator[tuple[str, bool]]:
        """Yields (sentence, is_first). The first chunk is flushed at the
        earliest clause boundary past `first_flush_chars` so audio starts
        sooner; later chunks wait for real sentence boundaries.

        `on_tool(phase, tools)` fires on the agent's `barnaby.tool_call`
        frames — "started" when the model commits to a tool, "finished" when
        the results are in. It is a callback rather than a second kind of
        yielded value so that callers who do not care need no change, the same
        way `on_first_token` works.

        A tool turn is otherwise silence: round one produces no speakable text,
        so without this the caller cannot tell a thinking robot from a hung
        one. What to DO about it is the caller's business — the agent sends the
        fact and stays out of presentation.
        """
        payload: dict = {
            "model": self.model, "messages": messages, "stream": True,
            "max_tokens": self.max_tokens, "temperature": self.temperature,
        }
        if self.no_think:
            # Qwen3.x defaults to thinking-on. Chain-of-thought before "turning
            # off the kitchen lights" blows the budget many times over.
            payload["chat_template_kwargs"] = {"enable_thinking": False}

        buf = ""
        first = True
        async with self._http.stream("POST", self.url, json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data: "):
                    continue
                blob = line[6:].strip()
                if blob == "[DONE]":
                    break
                try:
                    import json
                    frame = json.loads(blob)
                except ValueError:
                    continue
                # The agent's tool-intent event, not a chat chunk. It carries
                # no `choices` at all, so it must be handled before anything
                # reaches for one — and anything unrecognised is skipped rather
                # than assumed to be speech.
                if frame.get("object") == "barnaby.tool_call":
                    if on_tool is not None:
                        try:
                            on_tool(frame.get("phase") or "",
                                    frame.get("tools") or [])
                        except Exception:            # noqa: BLE001
                            # An acknowledgement is a nicety. It must never be
                            # the reason an answer does not arrive.
                            log.exception("tool-intent callback failed")
                    continue
                try:
                    delta = frame["choices"][0].get("delta", {})
                except (KeyError, IndexError, TypeError):
                    continue
                piece = delta.get("content") or ""
                if not piece:
                    continue
                if on_first_token is not None:
                    on_first_token()          # Turn.mark is idempotent
                    on_first_token = None
                buf += piece

                while True:
                    pattern = _CLAUSE if (first and len(buf) >= first_flush_chars) \
                        else _SENTENCE
                    m = pattern.search(buf)
                    if not m and first and len(buf) >= first_flush_chars:
                        m = _SENTENCE.search(buf)
                    if not m:
                        break
                    cut = m.end()
                    chunk, buf = buf[:cut].strip(), buf[cut:]
                    if chunk:
                        yield chunk, first
                        first = False
                    else:
                        break

        if buf.strip():
            yield buf.strip(), first

    async def aclose(self) -> None:
        await self._http.aclose()


class TTS:
    """Rapid-MLX / OpenAI-compatible /v1/audio/speech, one request per sentence."""

    def __init__(self, base_url: str, model: str, voice: str,
                 rate: int = 24_000, timeout: float = 30.0):
        self.url = f"{base_url.rstrip('/')}/audio/speech"
        self.model = model
        self.voice = voice
        self.rate = rate
        self._http = httpx.AsyncClient(timeout=timeout)

    async def synth(self, text: str, retries: int = 3) -> np.ndarray:
        """One sentence to audio.

        Retries on 503/429: a single-model server rejects overlapping requests
        and also 503s while it is still loading weights on the first call.
        """
        payload = {"model": self.model, "voice": self.voice, "input": text,
                   "response_format": "wav"}
        for attempt in range(retries):
            r = await self._http.post(self.url, json=payload)
            if r.status_code in (429, 503) and attempt < retries - 1:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            break
        r.raise_for_status()
        audio, sr = sf.read(io.BytesIO(r.content), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != self.rate:
            # Cheap linear resample; the TTS rate is fixed in practice.
            n = int(len(audio) * self.rate / sr)
            audio = np.interp(np.linspace(0, len(audio), n),
                              np.arange(len(audio)), audio).astype("float32")
        return audio

    async def aclose(self) -> None:
        await self._http.aclose()


async def health(url: str, timeout: float = 2.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(url)
            return r.status_code < 500
    except (httpx.HTTPError, asyncio.TimeoutError):
        return False