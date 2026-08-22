"""Typed config loaded from YAML. Env vars expand as ${NAME}."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_ENV = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _expand(value):
    if isinstance(value, str):
        return _ENV.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand(v) for v in value]
    return value


@dataclass
class AudioCfg:
    input_device: str | int | None = None
    output_device: str | int | None = None
    input_channels: int | None = None   # None = use the device's native count
    input_channel: int = 0              # XVF3800: ch0 is the processed output
    preroll_ms: int = 500
    hangover_ms: int = 350          # lower = snappier, higher = fewer cut-offs
    min_speech_ms: int = 250
    max_utterance_ms: int = 15_000
    barge_in_ms: int = 200
    barge_in_enabled: bool = True   # needs playback routed through the array
    playback_rate: int = 24_000   # 16000 when playing through the XVF3800


@dataclass
class WakeCfg:
    model: str = "models/barnaby.onnx"
    threshold: float = 0.5


@dataclass
class MacCfg:
    """Rapid-MLX serves one model per instance, so three ports."""
    asr_url: str = "http://mac.local:8000/v1"
    asr_model: str = "whisper-large-v3-turbo"
    llm_url: str = "http://mac.local:8001/v1"
    llm_model: str = "qwen3.8-27b-4bit"
    tts_url: str = "http://mac.local:8002/v1"
    tts_model: str = "kokoro"
    tts_voice: str = "af_heart"
    language: str = "en"
    max_tokens: int = 400
    temperature: float = 0.4


@dataclass
class HACfg:
    enabled: bool = True
    base_url: str = "http://homeassistant.local:8123"
    token: str = ""
    agent_id: str = "conversation.home_assistant"
    area: str = "Kitchen"


@dataclass
class FaceCfg:
    host: str = "0.0.0.0"
    port: int = 8711


@dataclass
class BehaviourCfg:
    chirp_on_device_command: bool = True
    sleep_after_frames: int = 2250   # 80 ms frames -> ~3 minutes


@dataclass
class Config:
    audio: AudioCfg = field(default_factory=AudioCfg)
    wake: WakeCfg = field(default_factory=WakeCfg)
    mac: MacCfg = field(default_factory=MacCfg)
    home_assistant: HACfg = field(default_factory=HACfg)
    face: FaceCfg = field(default_factory=FaceCfg)
    behaviour: BehaviourCfg = field(default_factory=BehaviourCfg)
    targets: dict = field(default_factory=lambda: {
        "device_command_ms": 700, "spoken_answer_ms": 2000})

    @classmethod
    def load(cls, path: str | Path) -> "Config":
        raw = _expand(yaml.safe_load(Path(path).read_text()) or {})
        return cls(
            audio=AudioCfg(**raw.get("audio", {})),
            wake=WakeCfg(**raw.get("wake", {})),
            mac=MacCfg(**raw.get("mac", {})),
            home_assistant=HACfg(**raw.get("home_assistant", {})),
            face=FaceCfg(**raw.get("face", {})),
            behaviour=BehaviourCfg(**raw.get("behaviour", {})),
            targets=raw.get("targets", {"device_command_ms": 700,
                                        "spoken_answer_ms": 2000}),
        )
