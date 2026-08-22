# Barnaby — Project Context

Drop this in the repo root as `CLAUDE.md` and Claude Code will read it as
project context automatically.

---

## What this is

A companion robot for a kitchen counter, shared by a married couple. Answers
questions, runs the house via Home Assistant, and reacts with a screen face and
a moving head. Named Barnaby — three syllables, hard consonants, nothing on TV
triggers it. The name is also the wake word.

**Form:** rounded creature, penguin/owl silhouette. ~200 mm tall, 190 mm body.
Head is a sphere truncated by a plane — an 83 mm flat facet holding a 2.1″ round
LCD. Static base, 3-DOF head. Body glows from within via an LED ring behind a
translucent lower shell.

---

## Topology

| Machine | Runs | Our code? |
|---|---|---|
| **Mac Studio** M3 Ultra 96 GB | 3× `rapid-mlx serve` — Whisper, LLM, Kokoro | **No** |
| **Pi 5** (in Barnaby) | Orchestrator, face renderer | Python + TS |
| **HA box** (not yet built) | Home Assistant, Music Assistant | No |
| **ESP32-S3** (not yet built) | Servos, body glow, touch, IMU | C++ |

```
mic → wake → VAD → ASR(Mac) → HA Assist ─┬─ matched → chirp
                                          └─ no match → LLM(Mac) → TTS(Mac) → speaker
                                                        streamed, sentence by sentence
```

Mac command lines — **`--host 0.0.0.0` and `--no-think` are both required:**

```bash
rapid-mlx serve whisper-large-v3-turbo --port 8000 --host 0.0.0.0
rapid-mlx serve qwen3.8-27b-4bit       --port 8001 --host 0.0.0.0 --no-think
rapid-mlx serve kokoro                 --port 8002 --host 0.0.0.0
```

---

## Repos

**`barnaby-orchestrator/`** — Python 3.11, runs on the Pi.
`pipeline.py` state machine · `clients.py` ASR/LLM/TTS/HA · `listen.py` wake +
VAD · `audio.py` capture/playback · `face.py` WebSocket server · `metrics.py`
per-turn latency · `config.yaml`

**`barnaby-face/`** — TypeScript + Vite + Canvas 2D, 480×480.
`expressions.ts` state table · `layout.ts` mm constants · `face.ts` renderer ·
`scripts/check-fit.ts` **geometry regression — must pass before build**

**Design docs** — `parts-audit.md`, `pi-setup-guide.md`, `wiring-guide.md`,
`robot-form-study.html` (interactive 3D form + expression study).

---

## Current state

**Working:** full conversation end to end, **now including live microphone
input** (2026-08-22). LLM streaming, sentence-pipelined TTS, playback, face
channel, per-turn latency instrumentation. Face renderer with six moods, three
faults, blink-masked shape swaps, pointer-tracked gaze.

Voice is `bm_fable`. Multi-turn context already works — `_answer` feeds the
last three exchanges back to the LLM — but only if you say the wake word again
each time.

**Baseline (2026-08-21, `--say`, no mic):**

```
llm_sent -> first_token        680 ms   ← largest stage; verify --no-think
first_token -> first_sentence  205 ms   ← buffering to a clause boundary
first_sentence -> speaking     603 ms   ← Kokoro first clip
TIME TO FIRST AUDIO           1488 ms   budget 2000  OK
```

Mac shows low GPU and near-zero CPU at this load — lots of headroom.

**Audio, as of 2026-08-22.** The ReSpeaker XVF3800 **does not enumerate** — it
never appears in `lsusb`, `arecord -l` or `--devices`. Possibly the I2S
firmware variant. Until it does, input is an analog mic on the Waveshare card
(`"USB PnP"`, card 0, ch0), which means no beamforming, no AEC, no far-field.
Three diagnostics were added while chasing this: `--levels` (per-channel dBFS
meter), `--record N` (capture the exact device+channel the pipeline reads, to a
wav), and a no-speech guard that bails a turn after 3 s instead of stalling for
the full 15 s cap.

**Wake word:** validated with openWakeWord's pretrained `hey_jarvis`. A custom
"barnaby" model is still untrained.

**Not working / not built:** custom wake word, follow-up turns without
re-waking, Home Assistant (no instance, so tier 0 is off and everything hits
the LLM), tool calling, camera and face tracking, identity, ESP32, CAD.

---

## Decisions already made — do not relitigate

- **Python only on the Pi**, forced solely by `picamera2` being Python-only.
  The Mac runs no code of ours; everything is OpenAI-compatible HTTP.
- **HA on its own box, never on the Mac.** Docker on macOS has no host
  networking (breaks mDNS/SSDP discovery) and no USB passthrough (breaks the
  Zigbee radio). Also: rebooting the Mac must not take the lights down.
- **Screen face, not a lens.** Personality comes from the display; head motion
  is for attention. A lens on a stalk reads as surveillance.
- **Faults outrank moods.** The face is a pure view; the orchestrator owns all
  policy.
- **Head tilt is a 24° cone**, not ±40°. Geometric: the support column passes
  through an aperture in the head's underside that must stay hidden below the
  collar. `2 × tilt + β ≤ 65°`. Yaw is unconstrained at ±175°.
- **Camera in the bezel**, top-centre, 6 mm countersunk aperture (a 120° lens
  behind a straight hole vignettes).
- **TTS requests may overlap.** Early 503s were Kokoro loading weights, not a
  concurrency limit — verified with four simultaneous 200s.
- **No torch, no tensorflow anywhere.** The VAD downloads a 2 MB `.onnx` to
  `~/.cache/barnaby/` and runs it under onnxruntime.

---

## Gotchas found the hard way

| Thing | Detail |
|---|---|
| `rapid-mlx` binds `127.0.0.1` | Needs `--host 0.0.0.0`. Also check macOS → Privacy & Security → **Local Network** |
| openwakeword | Hard-depends on `tflite-runtime`, no cp313 wheels. Optional `[wake]` extra, needs Python 3.11/3.12 |
| `silero-vad` package | Declares torch. We fetch the `.onnx` directly instead |
| XVF3800 | Multi-channel. **ch0 = beamformed + AEC**, rest are raw capsules. Wrong channel looks like "barge-in is broken" |
| `playback_rate` | 24000 on the USB card, **16000** on the array. Mismatch = wrong pitch and speed |
| Barge-in | Only works with playback routed through the array — its AEC needs the reference. Currently `false` |
| Speaker connector | Board is JST PH 2.0; speakers are XH 2.5. Pigtail needed. Board connector is **top-entry** — affects CAD clearance |
| setuptools | Needs explicit `packages = ["barnaby"]`. Or skip packaging: `pip install -r requirements.txt` and `python -m barnaby` |

---

## Hardware

**Have:** Pi 5 · ReSpeaker XVF3800 (USB) · 2× MAX98357A · 2× 5 W 8 Ω enclosed
speakers · 2× Gikfun 40 mm · Waveshare USB sound card · 7× Feetech STS3215
(7.4 V) · FE-URT-1 bus controller · 2× WS2812 24-LED rings · Arducam IMX708 75°

**On order:** Camera Module 3 Wide · 2.1″ round 480×480 micro-HDMI panel ·
ESP32-S3

**Still needed:** M.2 HAT + NVMe · 7.4 V buck (**wrong voltage kills all six
servos at once**) · flat ribbon micro-HDMI · JST PH 2.0 pigtail · bearings ·
MPR121 · IMU · HA box + ZBT-1

---

## Next, in order

1. **Get the ReSpeaker enumerating.** Everything about far-field, AEC and
   barge-in is blocked on it, and tuning done against a close-talk mic will not
   transfer.
2. **Follow-up turns.** History already works; the gap is that every turn needs
   the wake word. Wanted: a short window after Barnaby finishes speaking where
   VAD alone starts a turn. Decisions to make — how long the window stays open,
   whether tier 0 chirps open one too, and when history should lapse (it never
   expires today, so this morning's conversation is still in context tonight).
3. **Wake word.** Train "barnaby" from synthetic speech — `hey_jarvis` already
   proves the path — then test against the real kitchen, TV on, extractor
   running. Retune `preroll_ms` at the same time; too much of it and the wake
   phrase lands in the transcript.
4. **Home Assistant.** Biggest felt improvement: device commands drop from
   ~1.5 s to ~50 ms. Name areas the way you actually speak.
5. **Tool calling.** Tier 1 answers but cannot act. Benchmark reliability on the
   local model — small models are weak at multi-step tool use.
6. **Attack the 680 ms TTFT.** Confirm `--no-think`. Consider 8-bit for better
   tool-call reliability; there's headroom.
7. **Camera + face tracking** when the Wide arrives — emits `look` on the face
   channel, which the renderer already consumes.
8. **ESP32 firmware.**

**Deferred to a later conversation: all CAD.** The parametric model in
build123d is blocked on measuring the HDMI control board, its FPC length, and
camera depth — those decide whether the board lives in the head or the body,
which sets the column diameter and therefore the tilt cone.