# Barnaby — Project Context

Drop this in the repo root as `CLAUDE.md` and Claude Code will read it as
project context automatically.

---

## What this is

A companion robot for a kitchen counter, shared by a married couple. Answers
questions, runs the house (Control 4 today; Home Assistant intended as the hub
later), and reacts with a screen face and a moving head. Named Barnaby — three
syllables, hard consonants, nothing on TV triggers it. The name is also the
wake word.

**Form:** rounded creature, penguin/owl silhouette. ~200 mm tall, 190 mm body.
Head is a sphere truncated by a plane — an 83 mm flat facet holding a 2.1″ round
LCD. Static base, 3-DOF head. Body glows from within via an LED ring behind a
translucent lower shell.

---

## Topology

| Machine | Runs | Our code? |
|---|---|---|
| **Mac Studio** M3 Ultra 96 GB | 3× `rapid-mlx serve` — Whisper, LLM, Kokoro. **Plus the Node agent server** (not built) | Yes, soon |
| **Pi 5** (in Barnaby) | Orchestrator, face renderer | Python + TS |
| **Control 4** controller | The actual home automation, today | No |
| **HA box** (not yet built) | Home Assistant as hub over Control 4, Music Assistant | No |
| **ESP32-S3** (not yet built) | Servos, body glow, touch, IMU | C++ |

```
Today:
mic → wake → VAD → ASR(Mac) → LLM(Mac) → TTS(Mac) → speaker
                              streamed, sentence by sentence

Intended — tier 0 becomes ours, in the Node server, over a Control 4 adapter:
mic → wake → VAD → ASR → agent(Mac) ─┬─ intent match → device + chirp
                                      └─ no match → LLM → tools → TTS → speaker
```

Mac command lines — **`--host 0.0.0.0` and `--no-think` are both required:**

```bash
rapid-mlx serve whisper-large-v3-turbo --port 8000 --host 0.0.0.0
rapid-mlx serve qwen3.8-27b-4bit       --port 8001 --host 0.0.0.0 --no-think
rapid-mlx serve kokoro                 --port 8002 --host 0.0.0.0
```

---

## Repos

Directories are `orchestrator/` and `face/`. Older docs call them
`barnaby-orchestrator/` and `barnaby-face/` — those names do not exist, and the
rsync line in `pi-setup-guide.md` used one.

**`orchestrator/`** — Python 3.11, runs on the Pi. Deployed by **`./deploy.sh`**
from the repo root, which rsyncs and restarts the service (`--logs` to follow
the journal, `--install` for a fresh Pi). It runs as a systemd **user** unit,
so `systemctl --user`, never sudo.
`pipeline.py` state machine · `clients.py` ASR/LLM/TTS/HA · `listen.py` wake +
VAD · `audio.py` capture/playback · `face.py` WebSocket server · `metrics.py`
per-turn latency · `config.yaml`

Diagnostics, in the order you want them: `--devices` · `--levels` (per-channel
dBFS meter) · `--record N` (capture the exact device+channel to a wav) ·
`--check` · `--say` · `--open-mic` · `--latency` (recorded turn latencies).

**`face/`** — TypeScript + Vite + Canvas 2D, 480×480.
`expressions.ts` state table · `layout.ts` mm constants · `face.ts` renderer ·
`src/check-fit.ts` **geometry regression, gates `pnpm build`**

Runs on a laptop until the panel arrives: `pnpm dev`, then
`http://localhost:5273/?ws=ws://barnaby.local:8711/face`. The `?ws=` override is
required — the default derives the socket host from whoever served the page.

**Design docs** — `parts-audit.md`, `pi-setup-guide.md`, `wiring-guide.md`,
`robot-form-study.html` (interactive 3D form + expression study).

---

## Current state

**Working:** full conversation end to end, **now including live microphone
input** (2026-08-22). LLM streaming, sentence-pipelined TTS, playback, face
channel, per-turn latency instrumentation. Face renderer with six moods, three
faults, blink-masked shape swaps, pointer-tracked gaze.

Voice is `bm_fable`. **A wake word opens a conversation, not a turn**
(2026-08-22): after speaking, Barnaby stays listening for `follow_up_ms`
(10 s) and lets VAD alone start the next turn, so "what about tomorrow" needs
no second wake word. `_answer` was already feeding the last three exchanges
back, so follow-ups resolve once they reach it.

The window opens only after playback drains — otherwise his own voice starts a
turn, the same trap barge-in has, and with output on a separate device there is
no AEC to save us. A session ends on silence, on an empty transcript (in a
kitchen that is the TV or the extractor, not a user), or on a tier 0 command.
History expires separately on `session_idle_ms` (3 min), so breakfast is not
still in context at dinner.

**10 s is deliberately generous and is the first knob to cut** if the
television starts winning turns — inside the window there is no wake word in
front of the mic, and VAD cannot tell a person from a TV. Untested against a
real kitchen so far.

**Baseline (2026-08-22, live mic on the array, tier 1)** — the real one, with
wake word, VAD endpointing and beamforming in the path:

```
wake -> endpoint              2833.0 ms   ← the user talking; not our latency
endpoint -> asr_sent             0.0 ms
asr_sent -> asr_done           379.1 ms   ← Whisper on the Mac
asr_done -> llm_sent             0.1 ms   ← no tier 0; nothing to match against
llm_sent -> first_token        357.5 ms
first_token -> first_sentence  200.9 ms   ← buffering to a clause boundary
first_sentence -> speaking     304.5 ms   ← Kokoro first clip
TIME TO FIRST AUDIO           1242.1 ms   budget 2000  OK
```

Faster than the older `--say` baseline (1488 ms) despite doing strictly more
work. Two stages moved: **TTFT 680 → 357 ms**, which was the largest stage and
the standing suspicion about `--no-think`; and Kokoro's first clip 603 → 305 ms.
Neither was changed deliberately, so treat the improvement as unexplained —
warm weights on the Mac is the obvious guess. `wake -> endpoint` is the user
speaking and does not count against the budget.

Previous, superseded (2026-08-21, `--say`, no mic): TTFT 680 ms, first clip
603 ms, 1488 ms to first audio.

Mac shows low GPU and near-zero CPU at this load — lots of headroom.

Metrics now **persist** (2026-08-22): every turn appends a JSON object to
`~/.cache/barnaby/turns.jsonl`, and `python -m barnaby --latency` prints a
median/min/max summary per stage. It excludes `--say` turns, which have no
`endpoint` mark and so start their clock later. Latency claims are checkable
now rather than depending on who was watching the terminal.

**Audio, as of 2026-08-22.** The ReSpeaker XVF3800 **now enumerates** —
`2886:001a`, ALSA card 3, after a long spell of not appearing in `lsusb`,
`arecord -l` or `--devices` at all. What preceded it: **a Pi reboot and a
physical unplug/replug of the array.** Which of the two did it is untested, but
that is the thing to try first if it ever goes missing again — and it retires
the I2S-firmware theory, since the board plainly speaks USB Audio Class when it
comes up at all. `input_device` is now `"reSpeaker"`, which restores
beamforming and far-field. Output is still the Waveshare card, so AEC has no
reference and `barge_in_enabled` stays `false`.

The likely mechanism is USB enumeration, not the array: the XVF3800 draws
meaningfully at boot, and a device that loses its handshake stays invisible
until the port is re-cycled. Worth watching once the M.2 HAT and the servo buck
land, since both make the power situation worse.

Two corrections to what was assumed while it was missing:

- **It is a 2-channel device, not a multi-channel one.** The USB descriptor
  advertises one 2-channel 16 kHz S16_LE capture interface (chmap FL,FR); the
  XMOS DSP beamforms on-board and exposes no raw per-capsule feeds. So the
  "pick ch0 or you get a bare capsule" trap does not exist on this firmware.
  Measured on room ambience the channels are distinct but correlated (r = 0.89)
  with ch0 ~7 dB hotter. Use ch0.
- **Capture gain sits at max** (`Headset Capture Volume` 60/60 = 0 dB).
  Whether that is too hot is **not yet known** — see below.

**Confirmed working on the array (2026-08-22)** — wake word, far-field capture
and a full conversational turn, reported by Nick against a live run. This is
the first end-to-end validation with beamforming in the path; everything before
it was close-talk on the Waveshare mic.

It was working **with music playing in the room**, which is a stronger result
than a quiet-room test would have been and the first real evidence the
beamformer is earning its place.

Left deliberately untuned, because nothing yet says they need it:

- **Capture gain** stays at max (0 dB). The earlier "peaks near −1 dBFS,
  probably too hot" reading was measuring the music, not a noise floor, and
  supports no conclusion. It works as shipped; leave it until something fails.
- **`preroll_ms`** stays 250, and `vad_threshold` 0.5.

Worth knowing about the diagnostics: **a fluent transcript is not evidence of a
working microphone.** Whisper returned "I love you. I love you." for 7.7 s of
music with nobody speaking. Confirm against *known* words, which is exactly
what a real conversational turn does and a `--record` of an empty room does not.

Still unmeasured: usable range and off-axis angle, and behaviour with the
extractor running.

Three diagnostics were added while chasing the missing device: `--levels`
(per-channel dBFS meter), `--record N` (capture the exact device+channel the
pipeline reads, to a wav), and a no-speech guard that bails a turn after 3 s
instead of stalling for the full 15 s cap.

**Wake word:** validated with openWakeWord's pretrained `hey_jarvis`. A custom
"barnaby" model is still untrained.

**Not working / not built:** custom wake word,
the Node agent server, any home automation at all (the `home_assistant`
block in `config.yaml` points at an instance that does not exist, so tier 0 is
dead and everything hits the LLM), tool calling, camera and face tracking,
identity, ESP32, CAD.

---

## Decisions already made — do not relitigate

- **Python only on the Pi**, forced solely by `picamera2` being Python-only.
- **The agent loop lives on the Mac Studio, not the Pi** (decided 2026-08-22,
  reversing "the Mac runs no code of ours"). A Node server on the Mac exposes
  the same OpenAI-compatible `/v1/chat/completions` the Pi already calls —
  passthrough to rapid-mlx at first, then the home of tool calling and the rest
  of the agent logic. The Pi keeps everything real-time and hardware-adjacent:
  capture, wake word, VAD, playback, face, barge-in.

  The reason is **access, not latency** — a Pi→Mac hop is ~1 ms and irrelevant
  next to a 680 ms TTFT, but the Pi cannot read the Mac's files or mail, and
  tools must run where the data is. Secondary: agent loops are bad neighbours
  for hard real-time audio, and it ends the rsync-to-Pi cycle for prompt edits.
- **Centralise on the Mac Studio.** It is already always-on, already runs other
  critical household workloads, and Barnaby is *already* fully dependent on it
  — ASR is there, so a Mac outage takes voice down no matter how anything else
  is arranged. Fewer boxes, less to debug. Tier routing moves off the Pi too.
- **Home automation is Control 4 today, not Home Assistant.** HA appears all
  over these docs as a stand-in and **is not what the house runs**. The
  intention is to migrate to HA as the hub, orchestrating Control 4, but that
  is future work with no date. Consequences that bite now:
  - **There is no tier 0.** It was designed around HA Assist's local intent
    matcher. Control 4 has no equivalent, so `~50 ms device commands` and
    `targets.device_command_ms: 700` describe a system that does not exist.
  - **Build our own intent matcher** in the Node server — keyword matching over
    the device and room list pulled from the Control 4 controller, in front of
    the LLM. `clients.py` says writing one "would be strictly worse"; that was
    true only while HA was going to supply one free.
  - **Integrate behind an adapter.** Define the tool in intent terms (on, off,
    set level, room + device), with a Control 4 adapter now and an HA adapter
    later. Then the migration is one adapter swap and the agent never learns
    what Control 4 is. Practical path is the controller's local Director API,
    as used by HA's own integration via `pyControl4` — which is Python, so a
    Node server either reimplements it or runs a sidecar. Coverage is partial
    and Snap One has broken it before; do not build deep against it.
- **HA, when it arrives, goes on its own box, never on the Mac.** Docker on
  macOS has no host networking (breaks mDNS/SSDP discovery) and no USB
  passthrough (breaks the Zigbee radio). This is the one thing that cannot be
  centralised, so the floor is two always-on boxes. The house's own schedules,
  automations and physical switches must never route through the Mac or the Pi
  — voice is a convenience layer over a hub that stands alone.
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
| XVF3800 | **2 channels, not many** — the DSP beamforms on-board and exposes no raw capsules over USB. Use ch0 (~7 dB hotter than ch1). Descriptor is the authority here; the usual XMOS "ch0 beamformed, rest raw" lore does not match this firmware |
| `--devices` shows the array as `0 in / 2 out` | Its capture stream is already open — i.e. Barnaby is running. Looks identical to the device failing to enumerate, right after a period when it genuinely was. `fuser -v /dev/snd/pcmC3D0c` names the holder; `/proc/asound/card3/pcm0c/sub0/status` shows RUNNING |
| XVF3800 went missing, then came back | It failed to enumerate for a long stretch, then appeared on 2026-08-22 after **a Pi reboot plus an unplug/replug**. Try exactly that before suspecting firmware — the long detour into "it must be the I2S variant" cost real time and was wrong |
| `playback_rate` | 24000 on the USB card, **16000** on the array. Mismatch = wrong pitch and speed |
| Barge-in | Only works with playback routed through the array — its AEC needs the reference. Currently `false` |
| Speaker connector | Board is JST PH 2.0; speakers are XH 2.5. Pigtail needed. Board connector is **top-entry** — affects CAD clearance |
| setuptools | Needs explicit `packages = ["barnaby"]`. Or skip packaging: `pip install -r requirements.txt` and `python -m barnaby` |
| **Every 15 s turn has two opposite causes** | Endpointing needs `min_speech` *before* it can fire, so a dead input can never end a turn early — it runs to `max_utterance_ms` and transcribes to nothing, exactly like an input so hot that noise reads as continuous speech. Identical symptom, opposite fix. `--levels` tells them apart |
| Wrong `input_device` fails silently | The Waveshare exposes 2 input channels, so pointing `input_device` at it *succeeds* and hands you a bare mic with no beamforming. Looks like "Whisper is bad." `--record N` then `aplay` is the check — `arecord -c 2` can't, it plays both channels |
| openwakeword needs `download_models()` | Mandatory **even with a custom model** — the shared melspectrogram and embedding models are separate. Skip it and `Model(...)` fails as if your `.onnx` were corrupt. `listen.py` pins `inference_framework="onnx"`, so the ONNX variants specifically must be present |
| `preroll_ms` reaches into the wake phrase | At 500 ms Whisper transcribes the wake word as part of the question ("Harvest, what's the weather"). Now 250. Retune per wake model — detection latency differs. Matters most for intent matching, which is brittle to a leading junk word |
| Kokoro voice list | Undocumented: `curl http://<mac>:8002/v1/audio/voices` → 53 voices. `<lang><gender>_<name>`, a=American b=British, f/m. Currently `bm_fable` |
| Reading the service log | `journalctl --user-unit barnaby -f`. **Not** `--user -u barnaby`, which looks in the user's own journal, finds nothing, and prints "No journal files were found" as if the service had never run. The unit's stdout goes to the *system* journal; `admin` reads it via the `adm` group |
| The journal is volatile | `/var/log/journal` does not exist, so `Storage=auto` keeps everything in `/run` and a reboot loses it. `sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal` fixes it, and needs a password |
| Deploying to the Pi | `./deploy.sh` — rsyncs and restarts the service. It is a **user** unit, so `systemctl --user`, never sudo (`admin` needs a password for sudo, which is why it is not a system unit). `journalctl --user-unit barnaby -f` for the log |
| `HA_TOKEN` | Put it in `~/barnaby/barnaby.env`, read by the unit's `EnvironmentFile`. A shell `export` does not survive a reboot, and unset silently disables tier 0 rather than erroring |
| face `check-fit` was unrunnable | `package.json` pointed at `scripts/check-fit.ts`; the file is `src/check-fit.ts`. Fixed 2026-08-22 and wired into `build`, so the geometry regression actually gates it now |

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

## Software

Toolchain, since the wrong guess is easy: the Pi uses **`uv`**, not Poetry —
`pyproject.toml` is setuptools. The face uses **`pnpm`**, not npm — pinned in
`devEngines`, with a lockfile. ONNX Runtime and Vite are ordinary declared
dependencies; nothing is installed by hand or globally.

Procedures live in the human-facing docs, not here:

- **`orchestrator/README.md`** — running it, rebuilding the venv, tuning knobs,
  and what survives a venv rebuild versus a reboot.
- **`docs/pi-setup-guide.md`** — blank SD card to a conversation.
- **`face/README.md`** — the panel constraint and the geometry check.
