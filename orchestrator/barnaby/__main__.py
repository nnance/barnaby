"""Entry point.

  python -m barnaby                 run against the Mac
  python -m barnaby --check         health-check every service and exit
  python -m barnaby --say "text"    skip audio in, test LLM+TTS+face only
  python -m barnaby --devices       list audio devices and exit
  python -m barnaby --levels        live input meter, per channel
  python -m barnaby --record 5      capture what the pipeline hears, to a wav
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import math
import sys

from .audio import FRAME, SAMPLE_RATE, Microphone, Speaker
from .clients import ASR, LLM, TTS, HomeAssistant, health
from .config import Config
from .face import FaceServer
from .listen import Endpointer, WakeWord
from .metrics import Turn
from .pipeline import Pipeline

log = logging.getLogger("barnaby")


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(name)-18s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )


async def check(cfg: Config) -> int:
    """Fail fast and say which box is down, rather than timing out mid-turn."""
    targets = [
        ("ASR  ", f"{cfg.mac.asr_url.rstrip('/')}/models"),
        ("LLM  ", f"{cfg.mac.llm_url.rstrip('/')}/models"),
        ("TTS  ", f"{cfg.mac.tts_url.rstrip('/')}/models"),
    ]
    if cfg.home_assistant.enabled:
        targets.append(("HA   ", f"{cfg.home_assistant.base_url.rstrip('/')}/"))
    ok = True
    for name, url in targets:
        up = await health(url)
        ok = ok and up
        print(f"{name} {'up  ' if up else 'DOWN'}  {url}")
    return 0 if ok else 1


def levels(cfg: Config) -> int:
    """Live per-channel input meter.

    Two jobs. It answers "is anything reaching the mic at all", which silence
    and a misconfigured device look identical without. It is also how you set
    capture gain: the array ships at max (0 dB). Watch the bars in a *quiet*
    room to find the floor, then while speaking at counter distance, and back
    it off with `amixer -c <N> sset Headset,0 Capture <n>` if speech peaks lack
    headroom. Kill any music first — it reads as a hot noise floor and will
    talk you into turning the gain down when nothing is wrong.

    Opens at the same rate and frame size the pipeline uses, so a device that
    fails here fails there too.
    """
    import numpy as np
    import sounddevice as sd

    device = cfg.audio.input_device
    channels = cfg.audio.input_channels
    if channels is None:
        channels = int(sd.query_devices(device, "input")["max_input_channels"])

    print(f"{device or 'default'} — {channels} channel(s) at {SAMPLE_RATE} Hz. "
          f"'*' marks ch{cfg.audio.input_channel}, the one Barnaby listens to.")
    print("Speak. Bars should move. Ctrl-C to stop.\n")

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=channels,
                        dtype="float32", device=device, blocksize=FRAME) as s:
        try:
            while True:
                block, _overflow = s.read(FRAME * 2)
                rms = np.sqrt(np.mean(np.square(block, dtype=np.float64), axis=0))
                cells = []
                for i, v in enumerate(rms):
                    db = 20 * math.log10(max(float(v), 1e-9))
                    bars = int(max(0.0, min(1.0, (db + 60) / 60)) * 10)
                    mark = "*" if i == cfg.audio.input_channel else " "
                    cells.append(f"{mark}ch{i}{db:5.0f} {'#' * bars:<10}")
                print(" ".join(cells), end="\r", flush=True)
        except KeyboardInterrupt:
            print()
    return 0


async def record(cfg: Config, seconds: float, path: str) -> int:
    """Capture the exact stream the pipeline sees, to a file you can play back.

    Goes through Microphone, so it applies the configured device *and* the
    channel selection. A healthy --levels reading on one channel and silence
    here means input_channel points at the wrong one.
    """
    import numpy as np
    import soundfile as sf

    mic = Microphone(cfg.audio.input_device, cfg.audio.preroll_ms,
                     cfg.audio.input_channels, cfg.audio.input_channel)
    await mic.start()
    print(f"recording {seconds:.0f}s from ch{cfg.audio.input_channel} — speak now")
    frames = [await mic.queue.get()
              for _ in range(int(seconds * SAMPLE_RATE / FRAME))]
    mic.stop()

    audio = np.concatenate(frames)
    sf.write(path, audio, SAMPLE_RATE)
    peak = 20 * math.log10(max(float(np.max(np.abs(audio))), 1e-9))
    rms = 20 * math.log10(max(float(np.sqrt(np.mean(np.square(audio)))), 1e-9))
    print(f"wrote {path} — peak {peak:.0f} dBFS, rms {rms:.0f} dBFS")
    print(f"play it back:  aplay {path}")
    return 0


async def main_async(args: argparse.Namespace) -> int:
    cfg = Config.load(args.config)

    if args.devices:
        import sounddevice as sd
        print(sd.query_devices())
        return 0
    if args.levels:
        return levels(cfg)
    if args.record:
        return await record(cfg, args.record, args.record_to)
    if args.check:
        return await check(cfg)

    face = FaceServer(cfg.face.host, cfg.face.port)
    await face.start()

    asr = ASR(cfg.mac.asr_url, cfg.mac.asr_model, cfg.mac.language)
    llm = LLM(cfg.mac.llm_url, cfg.mac.llm_model,
              max_tokens=cfg.mac.max_tokens, temperature=cfg.mac.temperature)
    tts = TTS(cfg.mac.tts_url, cfg.mac.tts_model, cfg.mac.tts_voice,
              rate=cfg.audio.playback_rate)
    ha = None
    if cfg.home_assistant.enabled and cfg.home_assistant.token:
        ha = HomeAssistant(cfg.home_assistant.base_url, cfg.home_assistant.token,
                           cfg.home_assistant.agent_id, cfg.home_assistant.area)
    elif cfg.home_assistant.enabled:
        log.warning("HA enabled but no token — tier 0 disabled, everything "
                    "will hit the LLM and device commands will feel slow")

    speaker = Speaker(cfg.audio.output_device, cfg.audio.playback_rate)
    await speaker.start()

    if args.say:
        # No microphone involved. Exercises LLM streaming, sentence-pipelined
        # TTS, playback and the face channel in one shot.
        mic = Microphone(None)
        pipe = Pipeline(cfg, mic, speaker, WakeWord(cfg.wake.model),
                        Endpointer(), face, asr, llm, tts, ha)
        turn = Turn()
        turn.text = args.say
        await face.set_mood("curious")
        if not await pipe._try_tier0(args.say, turn):
            await pipe._answer(args.say, turn)
        turn.report(cfg.targets)
        await asyncio.sleep(0.5)
        while speaker.is_playing:
            await asyncio.sleep(0.1)
        await face.set_mood("neutral")
        return 0

    mic = Microphone(cfg.audio.input_device, cfg.audio.preroll_ms,
                 cfg.audio.input_channels, cfg.audio.input_channel)
    ep = Endpointer(cfg.audio.hangover_ms, cfg.audio.min_speech_ms,
                    cfg.audio.max_utterance_ms, cfg.audio.vad_threshold)

    wake: WakeWord | None = None
    if not args.open_mic:
        wake = WakeWord(cfg.wake.model, cfg.wake.threshold)
        try:
            wake.load()
        except Exception as e:                    # noqa: BLE001
            log.error("wake word model %r failed to load: %s", cfg.wake.model, e)
            log.error("either train one, point wake.model at a bundled model "
                      "such as 'hey_jarvis', or run with --open-mic")
            return 2

    # Load models before opening the mic. A cold model on the first utterance
    # blows the latency budget and is the first thing anyone notices.
    ep.load()
    await mic.start()

    pipe = Pipeline(cfg, mic, speaker, wake, ep, face, asr, llm, tts, ha)
    try:
        await pipe.run()
    except asyncio.CancelledError:
        pass
    finally:
        mic.stop()
        await asyncio.gather(asr.aclose(), llm.aclose(), tts.aclose(),
                             face.stop(), return_exceptions=True)
        if ha is not None:
            await ha.aclose()
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="barnaby")
    p.add_argument("-c", "--config", default="config.yaml")
    p.add_argument("--check", action="store_true", help="health-check and exit")
    p.add_argument("--devices", action="store_true", help="list audio devices")
    p.add_argument("--levels", action="store_true",
                   help="live per-channel input meter — is the mic hearing anything?")
    p.add_argument("--record", type=float, metavar="SECONDS",
                   help="record the configured device+channel to a wav and exit")
    p.add_argument("--record-to", default="/tmp/barnaby-capture.wav",
                   help="where --record writes (default /tmp/barnaby-capture.wav)")
    p.add_argument("--say", metavar="TEXT", help="skip the microphone")
    p.add_argument("--open-mic", action="store_true",
                   help="no wake word — just talk. For testing before one exists.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    setup_logging(args.verbose)
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
