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
    # Applied to every playback gain stage at startup, as a percentage of the
    # control's range. None leaves the hardware alone.
    #
    # This is here rather than in ALSA's own state because mixer levels are
    # kernel state on one machine: not in git, not carried by deploy.sh, and
    # gone after a power cut unless someone remembered `alsactl store`. Setting
    # it every start makes it version-controlled and self-healing.
    playback_volume: int | list[int] | None = None
    # Speech dynamics. None disables compression entirely.
    #
    # This is not a nicety: on a small speaker, raw TTS is either clean or
    # audible across a room, not both, because speech peaks sit ~22 dB above
    # its average and the amp distorts on them long before the average gets
    # loud. Compression buys ~8 dB of usable loudness at the same peak level.
    playback_compression: dict | None = None


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
    llm_model: str = "qwen3.6-35b-8bit"
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

    # "I heard you, and I am working on it" — played once, when a turn is slow.
    #
    # Armed when the request goes out and cancelled when real audio reaches the
    # speaker, so it covers the whole wait rather than only a tool call. It was
    # tool-only at first, which was wrong twice over: it could not explain a
    # plain turn that stalled, and it fired part-way into a gap the user had
    # already been waiting through. The wait a user feels starts when they stop
    # talking.
    #
    # "bubbles" is four quick rising blips, ~0.6 s. The rising contour is the
    # part that says "still working" — a falling one reads as "done", which is
    # the wrong message while the answer is still coming.
    #
    # A continuous tone filling the whole wait was built and lived with, and it
    # was too much: reassuring for a second, wearing by the fifth. The finding
    # worth keeping is that one gesture with shape beats an unbroken sound; the
    # implementation is in git if it is ever wanted back.
    #
    # "chirp" is the original two descending notes — terser, and it says he
    # heard you without suggesting anything is ongoing. "speak" sends a line to
    # TTS, which costs a Kokoro round trip (~290 ms) inside the gap it is
    # covering and must finish playing before the answer starts. "none"
    # disables the sound and leaves only the face.
    tool_ack: str = "bubbles"        # bubbles | chirp | speak | none
    # Spoken only when tool_ack is "speak".
    tool_ack_text: str = "Let me check."
    # Wait this long before acknowledging, and cancel if the answer arrives
    # first. THIS THRESHOLD IS THE ONLY THING KEEPING HIM QUIET, since the
    # timer runs on every turn rather than only on tool turns.
    #
    # Measured to first audio: a cached plain question can come back in under
    # 700 ms and stay silent, while a tool turn takes ~3 s and always sounds.
    # Lower toward 300 to acknowledge nearly every turn — worth considering,
    # since "I heard you" is most useful when it is reliable. Raise toward 1500
    # to sound only on the genuinely slow ones.
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
