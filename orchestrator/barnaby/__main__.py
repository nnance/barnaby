"""Entry point.

  python -m barnaby                 run against the Mac
  python -m barnaby --check         health-check every service and exit
  python -m barnaby --say "text"    skip audio in, test LLM+TTS+face only
  python -m barnaby --devices       list audio devices and exit
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .audio import Microphone, Speaker
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


async def main_async(args: argparse.Namespace) -> int:
    cfg = Config.load(args.config)

    if args.devices:
        import sounddevice as sd
        print(sd.query_devices())
        return 0
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
                    cfg.audio.max_utterance_ms)

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
