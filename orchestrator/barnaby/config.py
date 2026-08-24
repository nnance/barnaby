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
    # Silero's speech/not-speech cutoff. Too low and room noise reads as
    # continuous speech, so the hangover never elapses and every utterance
    # runs to max_utterance_ms. Raise it on a noisy or high-gain input.
    vad_threshold: float = 0.5
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

    # After Barnaby finishes speaking, keep listening this long so a follow-up
    # needs no second wake word. 0 disables it and every turn needs waking.
    #
    # This is the one knob that trades conversation against false triggers:
    # the window is an open mic with no wake word in front of it, so anything
    # the room says during it is a candidate utterance. VAD gates it, but VAD
    # cannot tell your voice from the television's.
    follow_up_ms: int = 10_000
    # Only a *tier 1* answer opens a window. Device commands do not, because
    # they never reach history, so a follow-up would arrive with nothing to
    # resolve against — see BACKLOG. Flip when tier 0 exists and can.
    follow_up_after_tier0: bool = False
    # A session's history is cleared after this long with no turn, so this
    # morning's conversation is not still in context tonight. Independent of
    # the window above: history outlives it, deliberately, so re-waking within
    # the session still resolves "what about tomorrow".
    session_idle_ms: int = 180_000   # ~3 min, matching sleep_after_frames

    # What to do when the agent says a tool is running, which it does the
    # moment the model commits to one — measured ~950 ms in, against a gap of
    # ~1000 ms before the answer starts.
    #
    # "chirp" is the default for the same reason tier 0 chirps rather than
    # narrating: it is instant, needs no network, and costs nothing. "speak"
    # sends a line to TTS, which costs a Kokoro round trip (~290 ms for the
    # first clip) inside the very gap it is covering, and then has to finish
    # playing before the answer can start. "none" leaves only the face.
    tool_ack: str = "chirp"          # chirp | speak | none
    # Spoken only when tool_ack is "speak". Kept short for the reason above.
    tool_ack_text: str = "Let me check."
    # Wait this long after the tool starts before acknowledging, and cancel if
    # the answer arrives first. THIS IS THE POINT: an unconditional ack makes
    # fast turns worse — a chirp followed 200 ms later by the answer is noise.
    # Only turns that actually stall get acknowledged.
    #
    # Measured gap is ~1000 ms, so 700 fires on a typical tool turn while
    # staying silent on a fast one. Raise it if he chirps over himself.
    tool_ack_after_ms: int = 700


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
