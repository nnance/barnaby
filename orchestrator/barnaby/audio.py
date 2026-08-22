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

    def _callback(self, indata, _frames, _time, status) -> None:
        if status:
            log.debug("input status: %s", status)
        frame = indata[:, self.channel].copy()
        self.ring.append(frame)
        if self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self.queue.put_nowait, frame)
            except asyncio.QueueFull:
                pass          # dropping a frame beats blocking the audio thread

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

    @property
    def is_playing(self) -> bool:
        return self._playing.is_set()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            clip = await self.queue.get()
            if clip is None:                       # end-of-utterance sentinel
                self._playing.clear()
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

    def push(self, clip: np.ndarray) -> None:
        self.queue.put_nowait(clip)

    def end_utterance(self) -> None:
        self.queue.put_nowait(None)

    def interrupt(self) -> None:
        """Barge-in. Drop everything queued and cut the current clip."""
        self._stop.set()
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._playing.clear()


def iter_frames(audio: np.ndarray) -> Iterator[np.ndarray]:
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        yield audio[i:i + FRAME]
