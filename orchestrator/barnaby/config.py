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

    # "I heard you, I am working on it", while a turn is slow.
    #
    # Armed when the request goes out and cancelled by the first token, so it
    # covers the whole wait rather than only a tool call. It was tool-only at
    # first, which was wrong twice over: it could not explain a plain turn that
    # stalled, and it fired ~700 ms into a gap the user had already been
    # waiting through. The wait a user feels starts when they stop talking.
    #
    # "chirp" is the default for the reason tier 0 chirps rather than
    # narrating: instant, no network, no cost. "speak" sends a line to TTS,
    # which costs a Kokoro round trip (~290 ms) inside the gap it is covering
    # and must finish playing before the answer starts; it is said once and
    # then repeats as chirps, because a repeated sentence is narration.
    # "none" disables the sound and leaves only the face.
    # "hold" is the IVR pattern: a soft tone playing CONTINUOUSLY until the
    # answer starts, so there is never any silence to misread as a hang. It is
    # the most reassuring and also the most intrusive — it is a sound in your
    # kitchen for the whole wait, so try it before assuming you want it.
    tool_ack: str = "hold"           # hold | chirp | speak | none
    # Spoken only when tool_ack is "speak", and only the first time.
    tool_ack_text: str = "Let me check."
    # Wait this long before acknowledging, and cancel if the answer arrives
    # first. THIS THRESHOLD IS THE ONLY THING KEEPING HIM QUIET, now that the
    # timer runs on every turn rather than only on tool turns.
    #
    # Measured to first token: plain turn ~1200 ms, tool turn ~2200 ms. So 700
    # deliberately chirps on nearly everything that is not instant — chosen
    # because a chirp that only sometimes arrives is more startling than one
    # that reliably does. Raise it toward 1500 to go back to acknowledging
    # only the genuinely slow turns.
    tool_ack_after_ms: int = 700
    # How long each hold-tone segment is, when tool_ack is "hold". Segments
    # tile seamlessly; one is queued at a time so cancelling never leaves more
    # than this much tone to drain before the answer plays.
    #
    # 2000 matches the bubble pattern in `hold_tone`, whose last bubble starts
    # at 1.70 s. Shortening this TRUNCATES the pattern rather than speeding it
    # up — at 1000 you would hear only the first four bubbles and then a jump
    # back to the start. Change the pattern, not this, to retime the bubbles.
    tool_ack_segment_ms: int = 2000
    # Chirp again every this many ms while still waiting. 0 fires once only.
    # Ignored when tool_ack is "hold", which is continuous by definition.
    #
    # The case for repeating: after one chirp, silence is indistinguishable
    # from having crashed. The case against: a sound every two seconds on a
    # kitchen counter becomes an alarm. This is the first knob to raise if he
    # gets annoying, and 0 is the way back to a single chirp.
    tool_ack_repeat_ms: int = 2000


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
