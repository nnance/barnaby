"""The turn pipeline.

  IDLE ──wake──> LISTEN ──endpoint──> THINK ──> SPEAK ──┬──> IDLE
                   ^                                     │
                   ├──────────── barge-in ───────────────┤
                   └───── follow-up window (10 s) ───────┘

Three rules that are not obvious from the diagram:

  A WAKE WORD OPENS A CONVERSATION, NOT A TURN. After speaking, Barnaby keeps
  listening for `follow_up_ms` and lets VAD alone start the next turn, so
  "what about tomorrow" needs no second wake word. The window opens only after
  playback drains — otherwise his own voice would trigger it, since with output
  on a separate device there is no AEC. Sessions end on silence, on an empty
  transcript, or on a tier 0 command; history expires separately, on time.

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
import time

import numpy as np

from .audio import Microphone, Speaker
from .clients import ASR, LLM, TTS, HomeAssistant
from .config import Config
from .face import FaceServer
from .listen import BargeIn, Endpointer, WakeWord
from .metrics import Turn

log = logging.getLogger("barnaby.pipeline")

# How answers reach the user, and nothing else.
#
# Who Barnaby is, what he knows about the household, and what he must not say
# all live on the agent — it is the same Barnaby whoever is asking. What only
# the Pi knows is that its answers come out of a speaker with no screen, which
# is what everything here is about. A web chat calling the same agent would
# send the opposite: markdown renders, and length is cheap.
#
# The agent appends this to its own prompt rather than replacing it.
SYSTEM = """Your answers are spoken aloud through a speaker, and there is no screen.

Answer in one or two short sentences. Never use markdown, lists, or symbols —
write as you would speak. Say "degrees" rather than a degree sign, and write
numbers as you would say them, rounded the way a person would out loud: "a
hundred and nine", not "one hundred eight point nine"."""


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
        self._last_turn: float | None = None   # perf_counter of the last turn

    async def run(self) -> None:
        await self.face.set_mood("neutral")
        log.info("open mic — just start talking" if self.wake is None
                 else "listening for the wake word")
        while True:
            frame = await self.mic.queue.get()

            if self.speaker.is_playing:
                # Barge-in only works when playback goes through the array, so
                # its echo canceller has a reference to subtract. On a separate
                # output device he will hear himself and cut himself off.
                if not self.cfg.audio.barge_in_enabled:
                    continue
                if self.barge.feed(frame):
                    log.info("barge-in")
                    self.speaker.interrupt()
                    self.barge.reset()
                    await self._turn(preroll=self.mic.preroll())
                continue

            if self._triggered(frame):
                await self._turn(preroll=self.mic.preroll())
                # Same reason as the follow-up window: what queued up during
                # the turn is the past, and feeding several seconds of it to
                # the wake detector risks waking on Barnaby's own reply.
                self.mic.flush()
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

    def _expire_session(self) -> None:
        """Drop history once a conversation has gone cold.

        Without this `history` is a plain list living as long as the process,
        so a question at breakfast is still in the model's context at dinner —
        which is both a wrong-answer risk and a slow context leak.
        """
        idle_ms = self.cfg.behaviour.session_idle_ms
        if not idle_ms or self._last_turn is None or not self.history:
            return
        idle = (time.perf_counter() - self._last_turn) * 1000
        if idle >= idle_ms:
            log.info("session expired after %.0fs idle — clearing history",
                     idle / 1000)
            self.history.clear()

    async def _await_follow_up(self, turn: Turn | None = None) -> np.ndarray | None:
        """After speaking, listen for a follow-up without a wake word.

        Returns pre-roll for the next turn if the user starts talking inside
        the window, otherwise None.

        Two things this is careful about:

        - It waits for playback to actually drain first. Opening while audio is
          still going means Barnaby's own voice starts the next turn — the same
          failure barge-in has, and with output on a separate device there is
          no AEC to save us.
        - It requires *sustained* speech, not one loud frame, so a cupboard
          door does not open a turn. Same threshold `--open-mic` uses.
        """
        window_ms = self.cfg.behaviour.follow_up_ms
        if not window_ms:
            return None

        # Wait for the last clip to actually finish. Polling `is_playing` used
        # to do this and did not work: the flag is set by the playback task
        # when it dequeues a clip, so right after end_utterance() it is still
        # clear, the poll sails through, and the window opens into Barnaby's
        # own voice. The empty transcript that produced then ended the session
        # silently, which is exactly the "it needs the wake word again" report.
        await self.speaker.wait_until_idle()
        if turn is not None:
            turn.mark("playback_done")
            log.info("spoke for %.1fs; listening %d ms for a follow-up",
                     (turn.since("speaking", "playback_done") or 0) / 1000,
                     window_ms)

        # Everything queued up to here is the past — the room while Whisper,
        # the LLM and playback were busy, Barnaby's own voice included. Left
        # in, it is read in a single burst the instant the window opens, which
        # spends the window before the user has said anything. Listen from now.
        self.mic.flush()

        await self.face.set_mood("listening")
        self.ep.reset()
        speech_frames = 0
        deadline = time.perf_counter() + window_ms / 1000

        while time.perf_counter() < deadline:
            remaining = deadline - time.perf_counter()
            try:
                frame = await asyncio.wait_for(self.mic.queue.get(), remaining)
            except asyncio.TimeoutError:
                break
            if self.ep.is_speech(frame):
                speech_frames += 1
                if speech_frames >= 3:            # ~240 ms
                    log.info("follow-up")
                    return self.mic.preroll()
            else:
                speech_frames = 0

        log.info("follow-up window closed after %d ms — session over", window_ms)
        return None

    async def _turn(self, preroll: np.ndarray) -> None:
        """One wake word, then as many turns as the user keeps feeding.

        A session is a loop rather than a recursive call so a long conversation
        cannot grow the stack, and so `run()` still sees exactly one `_turn`
        per wake — idle counting and sleep stay its business.
        """
        self._expire_session()
        woken = True                    # this turn came from the wake word

        while True:
            turn = Turn()
            turn.mark("wake")
            if woken:
                await self.face.set_mood("surprise")     # the perk
                await asyncio.sleep(0.12)
            await self.face.set_mood("listening")

            audio = await self._record(preroll)
            turn.mark("endpoint")

            turn.mark("asr_sent")
            try:
                text = await self.asr.transcribe(audio)
            except Exception:                     # noqa: BLE001
                log.exception("ASR failed")
                await self.face.set_fault("offline")
                return
            turn.mark("asr_done")
            turn.text = text
            self._last_turn = time.perf_counter()
            if not text:
                # Whisper heard nothing usable. In a follow-up window that is
                # the television, a cough, or the extractor — the common case,
                # not an error. End the session quietly rather than reopening
                # and giving the room another go.
                await self.face.set_mood("neutral")
                return

            await self.face.set_mood("curious")   # thinking
            tier0 = await self._try_tier0(text, turn)
            if not tier0:
                await self._answer(text, turn)
            turn.report(self.cfg.targets)
            self._last_turn = time.perf_counter()

            if tier0 and not self.cfg.behaviour.follow_up_after_tier0:
                await self.face.set_mood("neutral")
                return

            preroll = await self._await_follow_up(turn)
            if preroll is None:
                await self.face.set_mood("neutral")
                return
            woken = False

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
        """Stream the LLM, fire TTS per sentence, play in order.

        TTS requests overlap deliberately — the server handles concurrency, so
        sentence three is synthesised while sentence one is still playing. The
        speaker queue keeps playback ordered regardless of completion order.
        """
        turn.tier = "tier1"
        messages = [{"role": "system", "content": SYSTEM},
                    *self.history[-6:],
                    {"role": "user", "content": text}]

        pending: list[asyncio.Task[np.ndarray]] = []
        reply: list[str] = []
        turn.mark("llm_sent")

        try:
            async for sentence, is_first in self.llm.stream_sentences(
                    messages, on_first_token=lambda: turn.mark("first_token")):
                if is_first:
                    turn.mark("first_sentence")
                reply.append(sentence)
                pending.append(asyncio.create_task(self.tts.synth(sentence)))
                await self._drain(pending, turn)
        except Exception:                          # noqa: BLE001
            log.exception("LLM failed")
            await self.face.set_fault("offline")

        while pending:
            await self._drain(pending, turn, wait=True)
        self.speaker.end_utterance()
        turn.mark("tts_done")

        turn.reply = " ".join(reply)
        if turn.reply:
            self.history += [{"role": "user", "content": text},
                             {"role": "assistant", "content": turn.reply}]

    async def _drain(self, pending: list, turn: Turn, wait: bool = False) -> None:
        """Push finished clips to the speaker, in sentence order."""
        while pending and (wait or pending[0].done()):
            try:
                clip = await pending.pop(0)
            except Exception:                      # noqa: BLE001
                log.exception("TTS failed — skipping a sentence")
                continue
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