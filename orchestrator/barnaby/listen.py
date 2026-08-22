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
    """Silero VAD plus a hangover timer. Decides when the user stopped talking.

    Runs the ONNX model through onnxruntime directly rather than via silero-vad's
    torch wrapper. The model is under a megabyte; pulling in torch to run it
    would add ~200 MB to a Raspberry Pi install for no benefit.
    """

    WINDOW = 512          # what Silero v5 expects at 16 kHz

    def __init__(self, hangover_ms: int = 350, min_speech_ms: int = 250,
                 max_utterance_ms: int = 15_000, threshold: float = 0.5):
        self.hangover = hangover_ms / 1000
        self.min_speech = min_speech_ms / 1000
        self.max_utterance = max_utterance_ms / 1000
        self.threshold = threshold
        self._sess = None
        self._state = None
        self._names: dict[str, str] = {}
        self.reset()

    def load(self) -> None:
        import onnxruntime as ort

        path = self._model_path()
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1     # tiny model; threads cost more than they save
        self._sess = ort.InferenceSession(path, opts,
                                          providers=["CPUExecutionProvider"])
        self._names = {i.name: i.name for i in self._sess.get_inputs()}
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        log.info("VAD loaded from %s (hangover %.0f ms)", path,
                 self.hangover * 1000)

    MODEL_URL = ("https://github.com/snakers4/silero-vad/raw/master/"
                 "src/silero_vad/data/silero_vad.onnx")

    @classmethod
    def _model_path(cls) -> str:
        """Fetch and cache the ~2 MB VAD model.

        We deliberately do NOT depend on the silero-vad package: it declares a
        torch dependency, and torch has no wheels for newer CPython on aarch64,
        which turns a 2 MB model into an unsatisfiable dependency tree. The
        .onnx is all we need and onnxruntime runs it directly.
        """
        from pathlib import Path
        from urllib.request import urlopen

        cache = Path.home() / ".cache" / "barnaby"
        dest = cache / "silero_vad.onnx"
        if dest.is_file() and dest.stat().st_size > 100_000:
            return str(dest)

        # If the package happens to be installed, use its copy — no download.
        try:
            from importlib.util import find_spec
            spec = find_spec("silero_vad")
            roots = (list(spec.submodule_search_locations)
                     if spec and spec.submodule_search_locations else [])
        except (ImportError, ValueError):
            roots = []
        for root in roots:
            for cand in (Path(root) / "data" / "silero_vad.onnx",
                         Path(root) / "silero_vad.onnx"):
                if cand.is_file():
                    return str(cand)

        cache.mkdir(parents=True, exist_ok=True)
        log.info("fetching the VAD model (one time, ~2 MB)")
        tmp = dest.with_suffix(".part")
        with urlopen(cls.MODEL_URL, timeout=60) as r, tmp.open("wb") as f:
            f.write(r.read())
        tmp.replace(dest)          # atomic, so a killed download can't poison the cache
        return str(dest)

    def reset(self) -> None:
        self.speech_s = 0.0
        self.silence_s = 0.0
        self.total_s = 0.0
        self._buf = np.zeros(0, dtype=np.float32)

    def is_speech(self, frame: np.ndarray) -> bool:
        """Silero wants 512-sample windows at 16 kHz; mic frames are 1280."""
        assert self._sess is not None, "call load() first"
        self._buf = np.concatenate([self._buf, frame])
        voiced = False
        while len(self._buf) >= self.WINDOW:
            window, self._buf = self._buf[:self.WINDOW], self._buf[self.WINDOW:]
            feed = {"input": window.reshape(1, -1).astype(np.float32),
                    "sr": np.array(SAMPLE_RATE, dtype=np.int64)}
            if "state" in self._names:
                feed["state"] = self._state
            out = self._sess.run(None, feed)
            prob = float(np.asarray(out[0]).reshape(-1)[0])
            if len(out) > 1 and "state" in self._names:
                self._state = np.asarray(out[1], dtype=np.float32)
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
