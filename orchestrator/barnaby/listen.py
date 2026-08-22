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

    # Silero's window size is NOT a free parameter, and getting it wrong does
    # not raise — the model runs happily and returns ~0.003 for everything,
    # speech included, so the whole system looks like a dead microphone. This
    # was hardcoded to 512 against a model that wants 576, which silently
    # disabled every VAD-dependent feature: endpointing fell back to the
    # no-speech timeout, and the follow-up window never heard a word.
    #
    # 512 is right for some published v5 exports and 576 for others, so it is
    # detected at load() rather than assumed. These are the sizes worth trying,
    # most likely first.
    # Measured on the current model against real speech, at threshold 0.5:
    #   576 -> 65% of speech frames, 0% of silence   <- correct
    #   640 -> 65% / 0%   (576 with slop; same behaviour)
    #   256 -> 12% / 0%   (partially responsive, not good enough)
    #   512 ->  0% / 0%   <- what was hardcoded, i.e. a dead VAD
    # Ordered best-known first so an ambiguous probe result still lands well.
    CANDIDATE_WINDOWS = (576, 512, 640, 256, 1024, 1536)
    WINDOW = 576

    def __init__(self, hangover_ms: int = 350, min_speech_ms: int = 250,
                 max_utterance_ms: int = 15_000, threshold: float = 0.5,
                 no_speech_ms: int = 3_000):
        self.hangover = hangover_ms / 1000
        self.min_speech = min_speech_ms / 1000
        self.max_utterance = max_utterance_ms / 1000
        self.threshold = threshold
        self.no_speech = no_speech_ms / 1000
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
        self.WINDOW = self._detect_window()
        self.reset()
        log.info("VAD loaded from %s (hangover %.0f ms, window %d)", path,
                 self.hangover * 1000, self.WINDOW)

    def _detect_window(self) -> int:
        """Find the window size this model actually wants.

        A mismatched size is silent: the graph accepts it and returns a near-
        zero probability forever. So probe with something speech-like and keep
        the size that reacts to it.

        The probe is a 140 Hz harmonic stack — a buzz at the pitch of the
        vocal folds — swept through three formant-ish filters so it moves the
        way a voice does. A crude imitation, but the distinction being drawn
        is coarse: on this model 576 scores it while 512 returns ~0.001, and
        measured against real speech those sizes detect 65% and 0% of frames
        respectively. It needs no audio files shipped alongside the code.
        """
        n = 8192
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        probe = np.zeros(n, dtype=np.float32)
        for h in range(1, 16):                      # harmonics of 140 Hz
            probe += np.sin(2 * np.pi * 140 * h * t) / h
        # Drift the spectral envelope so it is not a stationary tone, which is
        # the thing a VAD is specifically trained to reject.
        envelope = 1 + 0.5 * np.sin(2 * np.pi * 3.0 * t)
        probe *= envelope.astype(np.float32)
        probe *= 0.3 / max(float(np.abs(probe).max()), 1e-9)

        # The probe ranks candidates unreliably — measured against real speech
        # 576 is correct (65% of frames) and 256 is not (12%), yet the probe
        # scores 256 higher. So this is deliberately NOT a beauty contest: the
        # preferred size is kept unless it is *inert*, which is the failure
        # that actually happened and is unmistakable (0.0006 vs 0.17).
        DEAD = 0.05
        best_size, best_score = self.WINDOW, -1.0
        scores: list[tuple[int, float]] = []
        for size in self.CANDIDATE_WINDOWS:
            state = np.zeros((2, 1, 128), dtype=np.float32)
            score = 0.0
            try:
                for i in range(0, len(probe) - size, size):
                    feed = {"input": probe[i:i + size].reshape(1, -1),
                            "sr": np.array(SAMPLE_RATE, dtype=np.int64)}
                    if "state" in self._names:
                        feed["state"] = state
                    out = self._sess.run(None, feed)
                    score = max(score, float(np.asarray(out[0]).reshape(-1)[0]))
                    if len(out) > 1 and "state" in self._names:
                        state = np.asarray(out[1], dtype=np.float32)
            except Exception:                        # noqa: BLE001
                continue                             # size the graph rejects
            scores.append((size, score))
            # Strictly greater, so a tie keeps the earlier — i.e. better known
            # — candidate rather than whichever happened to be probed last.
            if score > best_score:
                best_size, best_score = size, score

        detail = ", ".join(f"{sz}:{s:.3f}" for sz, s in scores)
        preferred = dict(scores).get(self.WINDOW)

        if preferred is not None and preferred >= DEAD:
            log.debug("VAD window %d (%s)", self.WINDOW, detail)
            return self.WINDOW

        # The preferred size is inert on this model. Fall back to whatever did
        # respond, and say so loudly — a silently dead VAD disables endpointing
        # and the follow-up window while everything still appears to run.
        if best_score >= DEAD:
            log.warning("VAD window %d is inert on this model; using %d "
                        "instead (%s)", self.WINDOW, best_size, detail)
            return best_size

        log.error("no VAD window size responded (%s) — endpointing and the "
                  "follow-up window will not work", detail)
        return self.WINDOW

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
        # Clear the LSTM state too. Without this a new utterance inherits the
        # hidden state of the previous one — including, for the follow-up
        # window, Barnaby's own voice — which is exactly the context the model
        # uses to decide what counts as speech.
        if self._state is not None:
            self._state = np.zeros((2, 1, 128), dtype=np.float32)

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
        # Endpointing needs min_speech before it will fire, so a dead input can
        # never end a turn early — it stalls for the full cap and transcribes
        # to nothing. Bail out and say why, rather than hanging for 15 s.
        if self.speech_s == 0.0 and self.total_s >= self.no_speech:
            log.warning("no speech detected in %.1fs — input level too low? "
                        "check `python -m barnaby --levels`", self.total_s)
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
