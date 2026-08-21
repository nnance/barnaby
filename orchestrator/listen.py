"""Wake word and endpointing.

Endpointing is where perceived latency is silently lost. Wait 800 ms of silence
before deciding someone finished and you have added 800 ms to every single
turn. We use a short hangover (default 350 ms) plus a minimum utterance length,
which is aggressive but recoverable — if we cut someone off, their next words
arrive as a follow-up turn rather than being lost.
"""
from __future__ import annotations

import logging

import numpy as np

from .audio import SAMPLE_RATE

log = logging.getLogger("barnaby.listen")


class WakeWord:
    """openWakeWord. Train a custom 'barnaby' model from synthetic speech —
    no recording required — and drop the .onnx in models/."""

    def __init__(self, model_path: str, threshold: float = 0.5):
        self.model_path = model_path
        self.threshold = threshold
        self._model = None

    def load(self) -> None:
        from openwakeword.model import Model
        self._model = Model(wakeword_models=[self.model_path],
                            inference_framework="onnx")
        log.info("wake word loaded: %s (threshold %.2f)",
                 self.model_path, self.threshold)

    def feed(self, frame: np.ndarray) -> bool:
        """One 80 ms frame in, True if the wake word just fired."""
        assert self._model is not None, "call load() first"
        pcm = (frame * 32767).astype(np.int16)
        scores = self._model.predict(pcm)
        hit = any(s >= self.threshold for s in scores.values())
        if hit:
            self._model.reset()      # avoid re-firing on the same audio
        return hit


class Endpointer:
    """Silero VAD plus a hangover timer. Decides when the user stopped talking."""

    def __init__(self, hangover_ms: int = 350, min_speech_ms: int = 250,
                 max_utterance_ms: int = 15_000, threshold: float = 0.5):
        self.hangover = hangover_ms / 1000
        self.min_speech = min_speech_ms / 1000
        self.max_utterance = max_utterance_ms / 1000
        self.threshold = threshold
        self._model = None
        self.reset()

    def load(self) -> None:
        from silero_vad import load_silero_vad
        self._model = load_silero_vad(onnx=True)
        log.info("VAD loaded (hangover %.0f ms)", self.hangover * 1000)

    def reset(self) -> None:
        self.speech_s = 0.0
        self.silence_s = 0.0
        self.total_s = 0.0
        self._buf = np.zeros(0, dtype=np.float32)

    def is_speech(self, frame: np.ndarray) -> bool:
        """Silero wants 512-sample windows at 16 kHz; frames are 1280."""
        assert self._model is not None, "call load() first"
        import torch
        self._buf = np.concatenate([self._buf, frame])
        voiced = False
        while len(self._buf) >= 512:
            window, self._buf = self._buf[:512], self._buf[512:]
            prob = self._model(torch.from_numpy(window), SAMPLE_RATE).item()
            voiced = voiced or prob >= self.threshold
        return voiced

    def feed(self, frame: np.ndarray) -> bool:
        """True when the utterance is over and should be transcribed."""
        dt = len(frame) / SAMPLE_RATE
        self.total_s += dt
        if self.is_speech(frame):
            self.speech_s += dt
            self.silence_s = 0.0
        else:
            self.silence_s += dt

        if self.total_s >= self.max_utterance:
            log.warning("utterance hit the %.0fs cap", self.max_utterance)
            return True
        return self.speech_s >= self.min_speech and self.silence_s >= self.hangover


class BargeIn:
    """Watches for the user talking over Barnaby. Only trustworthy because the
    XVF3800 does hardware echo cancellation — without AEC this fires on his own
    voice and he interrupts himself constantly."""

    def __init__(self, endpointer: Endpointer, trigger_ms: int = 200):
        self.ep = endpointer
        self.trigger = trigger_ms / 1000
        self.voiced_s = 0.0

    def reset(self) -> None:
        self.voiced_s = 0.0

    def feed(self, frame: np.ndarray) -> bool:
        dt = len(frame) / SAMPLE_RATE
        if self.ep.is_speech(frame):
            self.voiced_s += dt
        else:
            self.voiced_s = max(0.0, self.voiced_s - dt)
        return self.voiced_s >= self.trigger
