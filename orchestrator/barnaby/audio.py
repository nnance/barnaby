"""Microphone capture and speaker playback.

Two details here matter more than they look:

1. PRE-ROLL. Wake-word models only fire *after* the word is finished, so by the
   time we start recording the user is already a few hundred ms into their
   sentence. We keep a rolling ring buffer and prepend it, otherwise every turn
   loses its first word.

2. THE PLAYBACK QUEUE IS THE STREAMING PRIMITIVE. TTS clips are pushed in as
   they are synthesised and played back to back, so Barnaby starts speaking
   sentence one while sentence three is still being generated.
"""
from __future__ import annotations

import asyncio
import collections
import logging
from typing import Iterator

import numpy as np
import sounddevice as sd

log = logging.getLogger("barnaby.audio")

SAMPLE_RATE = 16_000          # what wake word, VAD and Whisper all expect
FRAME = 1280                  # 80 ms — openWakeWord's native frame size


class Microphone:
    """Continuous capture. Frames go to an asyncio queue; a ring buffer keeps
    the last few hundred ms so we can prepend pre-roll on wake."""

    def __init__(self, device: str | int | None, preroll_ms: int = 500,
                 channels: int | None = None, channel: int = 0):
        self.device = device
        # The XVF3800 does not present a mono stream, so open it native and take
        # one channel. Note the count is smaller than the usual XMOS story
        # suggests: this firmware advertises exactly 2 capture channels at
        # 16 kHz (chmap FL,FR), beamformed on-board, with no raw per-capsule
        # feeds exposed over USB. ch0 is the one we want.
        self.channels = channels
        self.channel = channel
        self.queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=64)
        self.ring: collections.deque[np.ndarray] = collections.deque(
            maxlen=max(1, preroll_ms * SAMPLE_RATE // 1000 // FRAME)
        )
        self._stream: sd.InputStream | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dropped = 0

    def flush(self) -> None:
        """Discard everything queued, so the next read starts from now.

        Nothing drains the queue during ASR, the LLM stream or playback, so by
        the end of a turn it holds several seconds of whatever the room did
        while Barnaby was busy — including Barnaby. Any reader that means
        "listen from this moment" has to flush first, or it is really asking
        "what happened five seconds ago".
        """
        while True:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                return

    def _put(self, frame: np.ndarray) -> None:
        """Enqueue one frame, dropping the oldest if the reader has fallen
        behind. Runs on the event loop, not the audio thread.

        This must never raise. It is invoked via call_soon_threadsafe, so an
        exception here does not propagate to the caller — it lands in the
        loop's exception handler and prints a traceback per dropped frame,
        which is how a full queue turned into thousands of log lines.

        Dropping the *oldest* rather than the newest matters. The queue is the
        live microphone; when it overflows, the stale end is audio from before
        whatever the reader is now waiting for, and handing that over means
        replaying the past — for the follow-up window, that was Barnaby's own
        voice from several seconds earlier.
        """
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            self._dropped += 1
            if self._dropped % 100 == 1:
                log.debug("input queue full — dropped %d frame(s)", self._dropped)
            try:
                self.queue.put_nowait(frame)
            except asyncio.QueueFull:
                pass

    def _callback(self, indata, _frames, _time, status) -> None:
        if status:
            log.debug("input status: %s", status)
        frame = indata[:, self.channel].copy()
        self.ring.append(frame)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._put, frame)

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self.channels is None:
            info = sd.query_devices(self.device, "input")
            self.channels = int(info["max_input_channels"])
        if self.channel >= self.channels:
            raise ValueError(
                f"channel {self.channel} requested but device has "
                f"{self.channels}. Set audio.input_channel in config.yaml."
            )
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, blocksize=FRAME, channels=self.channels,
            dtype="float32", device=self.device, callback=self._callback,
        )
        self._stream.start()
        log.info("microphone open (device=%s, %d channel(s), using ch%d)",
                 self.device if self.device is not None else "default",
                 self.channels, self.channel)

    def preroll(self) -> np.ndarray:
        return np.concatenate(list(self.ring)) if self.ring else np.zeros(0, "float32")

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()


class Speaker:
    """Sequential playback queue with interruption, for barge-in."""

    def __init__(self, device: str | int | None, rate: int = 24_000):
        self.device = device
        self.rate = rate
        self.queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._playing = asyncio.Event()
        self._stop = asyncio.Event()
        # Clips pushed but not yet finished. `_playing` alone cannot answer
        # "is there audio still to come": it is set by the playback task when
        # it picks a clip *off* the queue, so between push() and the task
        # waking there is a window where work is queued and `_playing` is
        # still clear. Anyone polling `while is_playing` in that window sails
        # straight through and starts listening while Barnaby talks.
        self._outstanding = 0
        self._idle = asyncio.Event()
        self._idle.set()

    @property
    def is_playing(self) -> bool:
        """True while any clip is queued or playing.

        Deliberately not just `_playing`: see `_outstanding`. This is the
        predicate the follow-up window depends on, and getting it wrong opens
        the microphone into Barnaby's own voice.
        """
        return self._outstanding > 0 or self._playing.is_set()

    async def wait_until_idle(self) -> None:
        """Block until everything queued has finished playing.

        Preferred over polling `is_playing`, which is a property and so cannot
        close the race by itself.
        """
        await self._idle.wait()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            clip = await self.queue.get()
            if clip is None:                       # end-of-utterance sentinel
                self._playing.clear()
                self._settle()
                continue
            self._playing.set()
            self._stop.clear()
            try:
                sd.play(clip, self.rate, device=self.device, blocking=False)
                # Poll rather than block so barge-in can cut in mid-clip.
                dur = len(clip) / self.rate
                elapsed = 0.0
                while elapsed < dur and not self._stop.is_set():
                    await asyncio.sleep(0.02)
                    elapsed += 0.02
                if self._stop.is_set():
                    sd.stop()
            except Exception:                       # noqa: BLE001
                log.exception("playback failed")
            finally:
                # In `finally` so a failed clip still decrements. Otherwise one
                # playback error leaves the counter above zero for good and
                # Barnaby never listens again.
                self._outstanding = max(0, self._outstanding - 1)
                self._settle()

    def _settle(self) -> None:
        if self._outstanding == 0 and not self._playing.is_set():
            self._idle.set()

    def push(self, clip: np.ndarray) -> None:
        self._outstanding += 1
        self._idle.clear()
        self.queue.put_nowait(clip)

    def end_utterance(self) -> None:
        self.queue.put_nowait(None)

    def interrupt(self) -> None:
        """Barge-in. Drop everything queued and cut the current clip."""
        self._stop.set()
        while not self.queue.empty():
            try:
                dropped = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            # Discarded clips never reach the playback loop, so they have to
            # be accounted for here or the counter never returns to zero and
            # is_playing stays true forever.
            if dropped is not None:
                self._outstanding = max(0, self._outstanding - 1)
        self._playing.clear()
        self._settle()


def iter_frames(audio: np.ndarray) -> Iterator[np.ndarray]:
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        yield audio[i:i + FRAME]
