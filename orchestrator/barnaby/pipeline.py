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
        ack: asyncio.Task | None = None

        def stop_ack() -> None:
            """Real audio is about to play, so stop filling the wait.

            The trigger is a clip reaching the speaker, not a token arriving —
            see `first_token` for why the difference matters.
            """
            nonlocal ack
            if ack is not None:
                ack.cancel()
                ack = None
        # `_drain` calls this the instant the first clip is pushed, which is
        # the earliest moment the wait is genuinely over.
        self._stop_ack = stop_ack

        def first_token() -> None:
            # NOT a cancel point, deliberately.
            #
            # It was, and it was wrong: on a tool turn the model narrates in
            # round one ("let me check the forecast"), and the agent HOLDS that
            # text and usually drops it — so those tokens are never spoken. The
            # ack was dying at ~570 ms on words the user would never hear,
            # leaving the rest of the wait silent. Measured: first_token 569 ms,
            # tool_started 952 ms, actual audio 3771 ms.
            #
            # A token is not a sound. The only honest signal that the wait is
            # over is audio reaching the speaker, which is `_drain`.
            turn.mark("first_token")

        def on_tool(phase: str, tools: list[str]) -> None:
            """The agent says a tool is running.

            This no longer starts the acknowledgement — that is armed before
            the request now, because the wait a user feels starts when they
            stop talking, not when a tool happens to be chosen. What this is
            still for is the metrics: `tool_started` and `tool_done` are what
            let `--latency` say whether a slow turn was the model deciding,
            the tool running, or round two prefilling.
            """
            if phase == "started":
                turn.mark("tool_started")
                log.info("tool running: %s", ", ".join(tools) or "unnamed")
            elif phase == "finished":
                turn.mark("tool_done")

        turn.mark("llm_sent")

        # Armed BEFORE the request goes out, and cancelled when real audio
        # first reaches the speaker (in `_drain`).
        #
        # It used to be armed by the tool event, which meant it could only ever
        # explain a tool gap — and a plain turn that stalled said nothing at
        # all. But the wait a user feels has nothing to do with whether a tool
        # was involved: it starts the moment they stop talking. So the meaning
        # changed from "a tool is running" to "I heard you, I am working".
        #
        # The cost is that this now runs on EVERY turn, so the threshold is
        # doing all the work of keeping him quiet — see `_tool_ack`.
        if self.cfg.behaviour.tool_ack != "none":
            ack = asyncio.create_task(self._tool_ack(turn))

        try:
            async for sentence, is_first in self.llm.stream_sentences(
                    messages, on_first_token=first_token,
                    on_tool=on_tool):
                if is_first:
                    # NOT a cancel point either: a sentence has been segmented
                    # but not yet synthesised, and TTS can take seconds. This
                    # turn measured first_sentence -> speaking at 2542 ms, all
                    # of which the user would have spent in silence. `_drain`
                    # cancels, when there is audio.
                    turn.mark("first_sentence")
                reply.append(sentence)
                pending.append(asyncio.create_task(self.tts.synth(sentence)))
                await self._drain(pending, turn)
        except Exception:                          # noqa: BLE001
            log.exception("LLM failed")
            await self.face.set_fault("offline")
        finally:
            # A turn that died must not leave a tone playing into the next one,
            # or into the follow-up window.
            stop_ack()
            self._stop_ack = None

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
            # Real audio exists now, so stop filling the wait. This is the
            # cancel point rather than the first token because a token is not
            # a sound: on a tool turn round one's narration is held by the
            # agent and usually dropped, so cancelling there killed the tone
            # seconds before anything was actually audible.
            stop = getattr(self, "_stop_ack", None)
            if stop is not None:
                stop()
            if not self.speaker.is_playing:
                turn.mark("speaking")
                await self.face.set_mood("happy")
            self.speaker.push(clip)

    async def _tool_ack(self, turn: Turn) -> None:
        """Say "still working" while a turn is slow, until the answer starts.

        Armed before the request and cancelled by the first token, so the
        threshold is the only thing keeping him quiet on a fast turn — see
        `_answer`. Waits `tool_ack_after_ms`, chirps, then repeats every
        `tool_ack_repeat_ms` for as long as the wait lasts.

        Repeating is the point of the repeat: one chirp says "heard you", and
        on a genuinely long wait silence afterwards is indistinguishable from
        having crashed. It is also the risk — a sound every couple of seconds
        on a kitchen counter turns into an alarm, so `tool_ack_repeat_ms` is
        the knob to raise first, and 0 turns it back into a single chirp.

        Deliberately not spoken by default. A chirp is instant and needs no
        network; TTS costs a round trip inside the gap it is covering and then
        has to finish playing before the answer can start, which is how an
        acknowledgement turns into a delay. Same reasoning as tier 0's chirp.
        """
        behaviour = self.cfg.behaviour
        rate = self.speaker.rate
        try:
            await asyncio.sleep(behaviour.tool_ack_after_ms / 1000)

            if behaviour.tool_ack == "hold":
                await self._hold_tone(turn)
                return

            n = 0
            while True:
                if behaviour.tool_ack == "speak" and n == 0:
                    # Only ever spoken once. Repeating a sentence is narration,
                    # and narration is what the chirp exists to avoid.
                    clip = await self.tts.synth(behaviour.tool_ack_text)
                else:
                    clip = chirp(rate)
                # The answer may have arrived while TTS was running, or while
                # we slept. Losing that race is the failure this timer exists
                # to avoid, so check at the last moment before making a sound.
                if self.speaker.is_playing:
                    return
                n += 1
                if n == 1:
                    turn.mark("tool_ack")
                    log.info("acknowledging a slow turn (%s)", behaviour.tool_ack)
                self.speaker.push(clip)
                self.speaker.end_utterance()
                if not behaviour.tool_ack_repeat_ms:
                    return
                await asyncio.sleep(behaviour.tool_ack_repeat_ms / 1000)
        except asyncio.CancelledError:
            raise
        except Exception:                          # noqa: BLE001
            # Never let an acknowledgement break the turn it was decorating.
            log.exception("tool acknowledgement failed")

    async def _hold_tone(self, turn: Turn) -> None:
        """Play a continuous hold tone until cancelled — the IVR pattern.

        One segment is queued at a time, and the next is not pushed until the
        last has nearly finished. That is what makes this safe to cancel: the
        queue never holds tone that would have to play before the answer could,
        so stopping is just "stop pushing" and the tail is one segment at most.

        It deliberately does NOT call `speaker.interrupt()` to cut that tail.
        Interrupt drops the whole queue, and by the time the answer arrives its
        first clip may already be in it — cutting the tone would take the first
        sentence with it. A tone that overlaps the first word by a fraction of
        a second is a far smaller problem than an answer that never plays.
        """
        seg_ms = self.cfg.behaviour.tool_ack_segment_ms
        turn.mark("tool_ack")
        log.info("holding (tone) until the answer starts")
        phase = 0.0
        while True:
            # NOTE: there is deliberately no `if speaker.is_playing: return`
            # here, though the chirp path has one. It cannot work for a tone:
            # `is_playing` is true because THIS loop is playing, so the guard
            # fires on its own output and the tone stops after one segment —
            # which is exactly the "no tone at all" symptom. Cancellation from
            # `_drain` is the only stop signal, and it is a reliable one.
            self.speaker.push(hold_tone(self.speaker.rate, seg_ms, phase))
            self.speaker.end_utterance()
            # Carry the sine's phase so the next segment abuts this one without
            # a click. 440 Hz over seg_ms seconds, wrapped.
            phase = (phase + 2 * np.pi * 440.0 * (seg_ms / 1000)) % (2 * np.pi)
            # Wake slightly before the segment ends, so the next one is queued
            # while this is still playing and the tone stays unbroken. Too
            # early and segments pile up in the queue; this keeps at most one
            # waiting behind the one playing.
            await asyncio.sleep(max(0.05, (seg_ms - 60) / 1000))

    async def _speak_one(self, text: str, turn: Turn) -> None:
        clip = await self.tts.synth(text)
        turn.mark("speaking")
        self.speaker.push(clip)
        self.speaker.end_utterance()


# The bubbles in one hold-tone segment: (start seconds, base Hz).
#
# Deliberately uneven. Evenly spaced blips read as a machine ticking; uneven
# ones read as something bubbling, which is the whole point. Chosen by ear
# against a set of candidates — see docs/plans for the ones that lost.
_BUBBLES = (
    (0.04, 210.0), (0.26, 250.0), (0.50, 225.0), (0.72, 270.0),
    (0.96, 215.0), (1.20, 255.0), (1.44, 235.0), (1.70, 265.0),
)
# How long one bubble lasts, and how far its pitch rises over that time. The
# rise is what makes it a bubble rather than a beep: 2.6 means it ends at 3.6x
# its starting pitch, which is the "bloop" of something surfacing.
_BUBBLE_WIDTH_S = 0.16
_BUBBLE_SWEEP = 2.6


def hold_tone(rate: int, ms: int = 2000, phase: float = 0.0,
              level: float = 0.09) -> np.ndarray:
    """Bubbles, played while Barnaby is thinking. An acknowledgement tone.

    Meant to be played back-to-back for as long as the wait lasts. It tiles
    without a click for a simpler reason than the old sine did: every bubble
    begins and ends at silence inside the segment, so the segment's own edges
    are already zero and `phase` is accepted only for signature compatibility.

    Quiet on purpose — it sits under the room rather than announcing itself. A
    hold tone that demands attention is worse than silence, and this one plays
    for the whole wait rather than once.

    What it replaced: a 440 Hz sine pulsing hard on and off, which read as a
    telephone hold beep and was actively annoying. The lesson worth keeping is
    that the on/off chop was most of the problem — a continuous or overlapping
    texture is far easier to sit next to than a repeating beep.
    """
    n = int(rate * ms / 1000)
    t = np.arange(n, dtype=np.float32) / rate
    dur = ms / 1000
    out = np.zeros(n, dtype=np.float32)
    for start, f0 in _BUBBLES:
        if start >= dur:
            continue
        mask = (t >= start) & (t < start + _BUBBLE_WIDTH_S)
        if not mask.any():
            continue
        local = t[mask] - start
        # Pitch rises across the bubble: the "bloop".
        freq = f0 * (1 + _BUBBLE_SWEEP * local / _BUBBLE_WIDTH_S)
        # sin^2 rather than sin^3: softer than a click, but articulated enough
        # that the bubbles stay distinct instead of blurring into a hum.
        env = np.sin(np.pi * local / _BUBBLE_WIDTH_S) ** 2
        out[mask] += (env * np.sin(2 * np.pi * freq * local)).astype("float32")
    return (level * out).astype("float32")


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