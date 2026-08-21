"""The turn pipeline.

  IDLE ──wake──> LISTEN ──endpoint──> THINK ──> SPEAK ──> IDLE
                   ^                                        |
                   └────────────── barge-in ────────────────┘

Two rules that are not obvious from the diagram:

  TIER 0 NEVER TOUCHES A MODEL. "Turn off the kitchen lights" goes to Home
  Assistant, gets a local match in ~50 ms, and Barnaby chirps rather than
  narrating. Most kitchen traffic ends here.

  TTS IS PIPELINED. Sentences are synthesised as the LLM emits them and queued
  for playback, so speaking starts on sentence one while sentence three is
  still being generated. Time-to-first-audio stops depending on answer length.
"""
from __future__ import annotations

import asyncio
import logging

import numpy as np

from .audio import Microphone, Speaker
from .clients import ASR, LLM, TTS, HomeAssistant
from .config import Config
from .face import FaceServer
from .listen import BargeIn, Endpointer, WakeWord
from .metrics import Turn

log = logging.getLogger("barnaby.pipeline")

SYSTEM = """You are Barnaby, a companion robot on a kitchen counter in a shared home.

Answer in one or two short sentences. You are being spoken aloud, so never use
markdown, lists, or symbols — write as you would speak. If you do not know
something, say so plainly rather than guessing.

Never read out personal information unless you have been told who is asking."""


class Pipeline:
    def __init__(self, cfg: Config, mic: Microphone, speaker: Speaker,
                 wake: WakeWord | None, endpointer: Endpointer, face: FaceServer,
                 asr: ASR, llm: LLM, tts: TTS, ha: HomeAssistant | None):
        self.cfg = cfg
        self.mic = mic
        self.speaker = speaker
        self.wake = wake
        self.ep = endpointer
        self.barge = BargeIn(endpointer, cfg.audio.barge_in_ms)
        self.face = face
        self.asr = asr
        self.llm = llm
        self.tts = tts
        self.ha = ha
        self.history: list[dict] = []
        self._idle_frames = 0
        self._open_frames = 0        # open-mic trigger, used when wake is None

    async def run(self) -> None:
        await self.face.set_mood("neutral")
        log.info("open mic — just start talking" if self.wake is None
                 else "listening for the wake word")
        while True:
            frame = await self.mic.queue.get()

            if self.speaker.is_playing:
                if self.barge.feed(frame):
                    log.info("barge-in")
                    self.speaker.interrupt()
                    self.barge.reset()
                    await self._turn(preroll=self.mic.preroll())
                continue

            if self._triggered(frame):
                await self._turn(preroll=self.mic.preroll())
                self._idle_frames = 0
                continue

            # Doze off after a while. Nothing moving, nothing to say.
            self._idle_frames += 1
            if self._idle_frames == self.cfg.behaviour.sleep_after_frames:
                await self.face.set_mood("sleepy")

    def _triggered(self, frame: np.ndarray) -> bool:
        """Wake word, or — with `--open-mic` — any sustained speech. Open mic
        is for testing before a wake-word model exists; it will happily answer
        the television, so it is not a way to actually live with him."""
        if self.wake is not None:
            return self.wake.feed(frame)
        if self.ep.is_speech(frame):
            self._open_frames += 1
        else:
            self._open_frames = 0
        if self._open_frames >= 3:          # ~240 ms of speech
            self._open_frames = 0
            return True
        return False

    async def _turn(self, preroll: np.ndarray) -> None:
        turn = Turn()
        turn.mark("wake")
        await self.face.set_mood("surprise")     # the perk
        await asyncio.sleep(0.12)
        await self.face.set_mood("listening")

        audio = await self._record(preroll)
        turn.mark("endpoint")

        turn.mark("asr_sent")
        try:
            text = await self.asr.transcribe(audio)
        except Exception:                         # noqa: BLE001
            log.exception("ASR failed")
            await self.face.set_fault("offline")
            return
        turn.mark("asr_done")
        turn.text = text
        if not text:
            await self.face.set_mood("neutral")
            return

        await self.face.set_mood("curious")       # thinking
        if await self._try_tier0(text, turn):
            turn.report(self.cfg.targets)
            await self.face.set_mood("neutral")
            return

        await self._answer(text, turn)
        turn.report(self.cfg.targets)
        await self.face.set_mood("neutral")

    async def _record(self, preroll: np.ndarray) -> np.ndarray:
        """Collect until the endpointer says the user stopped."""
        self.ep.reset()
        chunks = [preroll] if len(preroll) else []
        while True:
            frame = await self.mic.queue.get()
            chunks.append(frame)
            if self.ep.feed(frame):
                break
        return np.concatenate(chunks)

    async def _try_tier0(self, text: str, turn: Turn) -> bool:
        """Home Assistant Assist. Local, ~50 ms, works with no internet."""
        if self.ha is None:
            return False
        try:
            result = await self.ha.process(text)
        except Exception:                         # noqa: BLE001
            await self.face.set_fault("haDown")
            return False
        await self.face.set_fault(None)
        turn.mark("tier0_done")
        if not result.handled:
            return False

        turn.tier = "tier0"
        # Acknowledge, don't narrate. A chirp beats four seconds of TTS
        # explaining what you already watched happen.
        if self.cfg.behaviour.chirp_on_device_command:
            turn.mark("speaking")
            self.speaker.push(chirp(self.speaker.rate))
            self.speaker.end_utterance()
        elif result.speech:
            await self._speak_one(result.speech, turn)
        return True

    async def _answer(self, text: str, turn: Turn) -> None:
        turn.tier = "tier1"
        messages = [{"role": "system", "content": SYSTEM},
                    *self.history[-6:],
                    {"role": "user", "content": text}]

        pending: list[asyncio.Task[np.ndarray]] = []
        reply: list[str] = []
        turn.mark("llm_sent")

        try:
            async for sentence, is_first in self.llm.stream_sentences(messages):
                if is_first:
                    turn.mark("first_token")
                    turn.mark("first_sentence")
                reply.append(sentence)
                # Fire TTS immediately; do not await it. Sentence n+1 is
                # generated while sentence n is being synthesised and played.
                pending.append(asyncio.create_task(self.tts.synth(sentence)))
                await self._drain(pending, turn)
        except Exception:                         # noqa: BLE001
            log.exception("LLM failed")
            await self.face.set_fault("offline")
            return

        while pending:
            await self._drain(pending, turn, wait=True)
        self.speaker.end_utterance()
        turn.mark("tts_done")

        turn.reply = " ".join(reply)
        self.history += [{"role": "user", "content": text},
                         {"role": "assistant", "content": turn.reply}]

    async def _drain(self, pending: list, turn: Turn, wait: bool = False) -> None:
        """Push finished TTS clips to the speaker, in order."""
        while pending and (wait or pending[0].done()):
            clip = await pending.pop(0)
            if not self.speaker.is_playing:
                turn.mark("speaking")
                await self.face.set_mood("happy")
            self.speaker.push(clip)

    async def _speak_one(self, text: str, turn: Turn) -> None:
        clip = await self.tts.synth(text)
        turn.mark("speaking")
        self.speaker.push(clip)
        self.speaker.end_utterance()


def chirp(rate: int, ms: int = 180) -> np.ndarray:
    """Two descending notes. Acknowledgement, not narration — zero latency,
    no network, and far more charming than 'OK, turning off the lights.'"""
    n = int(rate * ms / 1000)
    t = np.linspace(0, ms / 1000, n, dtype=np.float32)
    half = n // 2
    freq = np.concatenate([np.full(half, 880.0, dtype=np.float32),
                           np.full(n - half, 660.0, dtype=np.float32)])
    env = np.minimum(1.0, np.minimum(t * 60, (ms / 1000 - t) * 60)).astype("float32")
    return (0.22 * env * np.sin(2 * np.pi * freq * t)).astype("float32")
