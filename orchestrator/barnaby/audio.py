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
import re
import subprocess
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


def compress(audio: "np.ndarray", threshold: float = 0.12,
             ratio: float = 4.0, peak: float = 0.85,
             rate: int = 16_000) -> "np.ndarray":
    """Even out speech dynamics so it is audible across a room.

    Speech from Kokoro arrives with a ~22 dB crest factor — brief peaks far
    above its average. That is the whole problem with a small speaker: the
    amplifier distorts on the peaks while the *average* stays too quiet to hear
    from the far side of a kitchen, so the volume control alone can deliver
    clean or audible, never both. Measured here: clean at -9 dB and inaudible
    across the room, buzzing on transients 9 dB higher.

    Pulling the peaks down and lifting the whole clip raises loudness without
    raising peak level. Same reason broadcast audio is compressed.

    The envelope is smoothed over ~5 ms before it drives the gain. Per-sample
    gain would follow the waveform itself and buzz — which is the artefact this
    exists to remove, so getting that wrong is worse than not compressing.

    Defaults are tuned by ear on this hardware (2026-08-26): +8 dB average with
    no audible pumping. Harder settings were tried and rejected — ratio 6 and 8
    were louder still and sounded worse.
    """
    if audio.size == 0:
        return audio
    env = np.abs(audio)
    win = max(1, int(0.005 * rate))            # ~5 ms
    env = np.convolve(env, np.ones(win) / win, mode="same")
    gain = np.ones_like(env)
    over = env > threshold
    # Guard the divide: `over` already excludes zeros, but a denormal envelope
    # would still produce an enormous gain and a very loud surprise.
    gain[over] = (threshold + (env[over] - threshold) / ratio) / np.maximum(
        env[over], 1e-9)
    out = audio * gain
    top = float(np.abs(out).max())
    if top > 0:
        out = out * (peak / top)
    return out.astype("float32")


def _alsa_card(device: str | int | None) -> int | None:
    """ALSA card number for a sounddevice device name, or None.

    `output_device` is a *name* ("reSpeaker"), deliberately: card numbers move
    when hardware is added — plugging in the HDMI panel added vc4hdmi0/1 and
    pushed the array from card 3 to card 0. But `amixer` addresses cards by
    number, so the name has to be resolved at run time rather than written
    down anywhere.

    /proc/asound/cards holds both the short id and the full description, so a
    substring match against the whole line finds "reSpeaker" whether the user
    wrote the id or part of the product name.
    """
    if device is None:
        return None
    if isinstance(device, int):
        return None            # a sounddevice index is not an ALSA card index
    try:
        text = open("/proc/asound/cards").read()
    except OSError:
        return None
    want = device.lower()
    card: int | None = None
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)\s+\[", line)
        if m:
            card = int(m.group(1))
        if card is not None and want in line.lower():
            return card
    return None


def set_playback_volume(device: str | int | None,
                        percent: int | list[int]) -> None:
    """Set the playback gain stages on `device`.

    `percent` is either one number for every stage, or a list applied stage by
    stage in numid order. The list form exists because the two stages do not
    want the same value: tuned by ear, this array sounds right at stage 0 = 100
    and stage 1 = 90, and collapsing that to a single number changes the level.
    A list shorter than the stage count leaves the remaining stages alone.

    Why this exists at all: ALSA mixer levels live in kernel state on the Pi,
    not in the repo. They are the one piece of tuning that `deploy.sh` could
    not carry, they do not survive a power cut, and a fresh Pi comes up at
    whatever the hardware defaults to. Setting them from config on every start
    makes the level version-controlled and self-healing.

    THE XVF3800 HAS TWO PLAYBACK GAIN STAGES IN SERIES, and `amixer sget PCM`
    shows only the first. The second is `numid=6` ("PCM Playback Volume",
    index=1); it ships at 40/60 (-20 dB) and silently eats 20 dB, which is
    exactly as confusing to debug as it sounds. So this walks *every* numid
    whose name is a playback volume rather than touching one by name.

    Best-effort throughout: a missing amixer, an unreadable card, or a control
    that rejects the value must never stop Barnaby from starting. Quiet audio
    is a bad evening; no audio at all is a broken robot.
    """
    card = _alsa_card(device)
    if card is None:
        log.debug("no ALSA card for device %r — leaving volume alone", device)
        return
    try:
        listing = subprocess.run(
            ["amixer", "-c", str(card), "controls"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("could not list mixer controls on card %d: %s", card, e)
        return

    numids = [
        m.group(1)
        for line in listing.splitlines()
        if "playback volume" in line.lower()
        if (m := re.search(r"numid=(\d+)", line))
    ]
    if not numids:
        log.debug("card %d exposes no playback volume control", card)
        return

    wanted = [percent] * len(numids) if isinstance(percent, int) else percent
    applied = []
    for numid, pct in zip(numids, wanted):
        try:
            subprocess.run(
                ["amixer", "-c", str(card), "cset", f"numid={numid}", f"{pct}%"],
                capture_output=True, text=True, timeout=5, check=True,
            )
            applied.append(pct)
        except (OSError, subprocess.SubprocessError) as e:
            log.warning("could not set numid=%s on card %d: %s", numid, card, e)
    if len(wanted) < len(numids):
        # Worth saying out loud: a short list means a stage keeps whatever it
        # had, which is exactly the invisible-attenuation trap this function
        # exists to prevent.
        log.warning("card %d has %d playback stage(s) but only %d configured — "
                    "the rest keep their current level",
                    card, len(numids), len(wanted))
    if applied:
        log.info("playback volume %s on card %d",
                 ", ".join(f"{p}%" for p in applied), card)


class Speaker:
    """Sequential playback queue with interruption, for barge-in."""

    def __init__(self, device: str | int | None, rate: int = 24_000,
                 compression: dict | None = None):
        self.device = device
        self.rate = rate
        # None disables it entirely. Applied in push(), so every clip gets it —
        # the acknowledgement bubbles included, which otherwise sit at a very
        # different loudness from the speech around them.
        self.compression = compression
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
        if self.compression:
            clip = compress(clip, rate=self.rate, **self.compression)
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
