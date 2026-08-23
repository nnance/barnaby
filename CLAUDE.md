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
rapid-mlx serve lmstudio-community/Qwen3.6-35B-A3B-MLX-8bit \
  --served-model-name qwen3.6-35b-a3b-8bit --port 8001 --host 0.0.0.0 --no-think
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

**`--check` now proves the VAD detects speech**, synthesising a Kokoro clip and
running it through the endpointer — no microphone, room or person involved. It
prints `VAD ok window 576, 70% of speech frames detected`, or `DOWN ... 0%`.
Run it first when anything voice-related misbehaves: a dead VAD disables
endpointing and the follow-up window while Whisper keeps transcribing fine, so
every other symptom points at the microphone instead.

**`face/`** — TypeScript + Vite + Canvas 2D, 480×480.
`expressions.ts` state table · `layout.ts` mm constants · `face.ts` renderer ·
`src/check-fit.ts` **geometry regression, gates `pnpm build`**

Runs on a laptop until the panel arrives: `pnpm dev`, then
`http://localhost:5273/?ws=ws://barnaby.local:8711/face`. The `?ws=` override is
required — the default derives the socket host from whoever served the page.

**`agent/`** — TypeScript on the Mac Studio, **zero runtime dependencies**.
The gateway between the Pi and rapid-mlx, and the future home of tool calling.
Node 23+ strips types natively, so there is **no build step**: `pnpm start`
runs `src/main.ts` directly. `src/server.ts` routes + SSE plumbing ·
`src/upstream.ts` the only place an upstream URL is built · `bench.mjs` TTFT and
tok/s against any model · `PLAN.md` phases · `MODEL-NOTES.md` the 8-bit question.

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

**Confirmed working 2026-08-22**, wake word through to a pronoun-dependent
follow-up: "why is the sky blue" → spoke 9.2 s → window opened → "is that how
the rainbow works?" answered with no wake word, resolving "that" against
history. Session then closed cleanly on silence.

**10 s is deliberately generous and is the first knob to cut** if the
television starts winning turns — inside the window there is no wake word in
front of the mic, and VAD cannot tell a person from a TV. Not yet tested
against a TV actually running.

Note the wait before the window opens is the *answer length*: it opens only
once playback drains, so a 10 s answer means 10 s before a follow-up is
possible. `max_tokens` is deliberately back at 400 — Nick prefers the fuller
answers, and this is the cost.

**Baseline (2026-08-22, live mic on the array, tier 1)** — medians over 12
recorded turns, with wake word, VAD endpointing and beamforming in the path:

```
wake -> endpoint              2821.2 ms   ← the user talking; not our latency
endpoint -> asr_sent             0.0 ms
asr_sent -> asr_done           408.4 ms   ← Whisper on the Mac
asr_done -> llm_sent             0.2 ms   ← no tier 0; nothing to match against
llm_sent -> first_token        640.5 ms   ← 345-760, the widest-spread stage
first_token -> first_sentence  275.9 ms   ← buffering to a clause boundary
first_sentence -> speaking     285.9 ms   ← Kokoro first clip
TIME TO FIRST AUDIO           1608.2 ms   budget 2000 — 12/12 within it
```

**Read these rather than any single turn.** An earlier one-off showed TTFT at
357 ms and was written up here as an unexplained improvement over the 680 ms
`--say` baseline; across 12 turns the median is 640 ms with a 345-760 ms
spread, so that reading was just the fast end of normal variance. Nothing
improved and nothing regressed — the sample was too small to say either.
Getting this wrong in the obvious direction is what persistence is for.

`wake -> endpoint` is the user speaking and does not count against the budget.

Superseded (2026-08-21, `--say`, no mic): TTFT 680 ms, 1488 ms to first audio.

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
| A wrong Silero window size is **silent** | The model accepts any size, runs, and returns ~0.001 for every frame forever. `WINDOW` was 512 against an export wanting 576: measured on real speech, 576 detects 65-70% of frames and 512 detects **0%**. Symptom is a VAD that never fires, so endpointing falls through to the 3 s no-speech bail-out and the follow-up window hears nothing — while Whisper still transcribes fine, because it never needed the VAD. `load()` now probes for inertness and warns |
| "no speech detected in 3.0s" on a turn that transcribed perfectly | Not a microphone problem. It means the VAD returned False for every frame while Whisper heard you fine — i.e. the VAD is broken, not the input. This sat in the log for hours reading as a level problem |
| `preroll_ms` reaches into the wake phrase | At 500 ms Whisper transcribes the wake word as part of the question ("Harvest, what's the weather"). Now 250. Retune per wake model — detection latency differs. Matters most for intent matching, which is brittle to a leading junk word |
| Kokoro voice list | Undocumented: `curl http://<mac>:8002/v1/audio/voices` → 53 voices. `<lang><gender>_<name>`, a=American b=British, f/m. Currently `bm_fable` |
| Diagnosing "he can't hear me" | `python -m barnaby --check` first — it now includes a VAD speech test. A VAD returning zero looks exactly like a dead mic but is not, and the mic is the more tempting thing to blame. Only after that: `--levels`, then `--record N` |
| A quiet-room level reading proves nothing | Ambient noise reads ~-45 dBFS on *every* device, working or not, and Whisper hallucinates fluent sentences into near-silence ("I love you", "We'll be right back"). Both were mistaken for hardware faults this session. Play a known tone and capture it, or speak known words |
| Reading the service log | `journalctl --user-unit barnaby -f`. **Not** `--user -u barnaby`, which looks in the user's own journal, finds nothing, and prints "No journal files were found" as if the service had never run. The unit's stdout goes to the *system* journal; `admin` reads it via the `adm` group |
| The journal is volatile | `/var/log/journal` does not exist, so `Storage=auto` keeps everything in `/run` and a reboot loses it. `sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal` fixes it, and needs a password |
| Deploying to the Pi | `./deploy.sh` — rsyncs and restarts the service. It is a **user** unit, so `systemctl --user`, never sudo (`admin` needs a password for sudo, which is why it is not a system unit). `journalctl --user-unit barnaby -f` for the log |
| `HA_TOKEN` | Put it in `~/barnaby/barnaby.env`, read by the unit's `EnvironmentFile`. A shell `export` does not survive a reboot, and unset silently disables tier 0 rather than erroring |
| The system prompt has two owners | The agent owns identity, household context and safety — the same whoever asks. The **client** owns presentation: spoken aloud, no markdown, answer length, how to say a number. The agent cannot know whether its caller is a speaker or a web chat, so it appends the caller's system message rather than replacing it |
| The agent server picks the model, not the Pi | `BARNABY_MODEL` overrides whatever the Pi sends. Tools only work with a model that calls them reliably, so tools and model are one decision — when they were split, switching models needed edits on two machines and missing one 404'd every turn |
| Node strips types, it does not compile them | So `enum`, `namespace` and constructor parameter properties (`constructor(readonly x: number)`) fail **at runtime**, and `tsc --noEmit` passes them happily. Plain field declarations plus assignment in the constructor body. `pnpm test` is what catches it. **Not a permanent rule** — `tsx` (a devDependency and transpile step, not a runtime dependency) lifts it whenever the friction earns the build step; `agent/README.md` records what would justify that |
| Agent server abort must hook `res`, not `req` | `req` emits `close` as soon as the request body is read — *before* the first token — so hooking it there fires on every healthy turn and never on a real disconnect, and rapid-mlx keeps generating into a dead socket. `res` closes only when the socket actually goes |
| There is no drop-in 8-bit MTP model | `mlx-community/Qwen3.8-27B-MTP-8bit` is 451 MB — the MTP **draft head**, not a model. Real 8-bit is 29.5 GB and non-MTP, so upgrading costs +13.4 GB *and* speculative decoding at once. See `agent/MODEL-NOTES.md` |
| Thinking is already off server-side | `reasoning_parser: null`, `default_reasoning_level: "none"`. So a dropped `chat_template_kwargs` would **not** show up as `<think>` tags — behaviour cannot detect that regression, only a byte-level assertion on the forwarded body can |
| face `check-fit` was unrunnable | `package.json` pointed at `scripts/check-fit.ts`; the file is `src/check-fit.ts`. Fixed 2026-08-22 and wired into `build`, so the geometry regression actually gates it now |

---

## Debugging the voice path

Learned expensively on 2026-08-22, when the follow-up window "not working"
produced three confident wrong diagnoses before the real one. All three were
plausible, and each was believed because a *fake* confirmed it.

**Test against ground truth, not against a fixture you wrote.** The bug was
found in minutes once a known Kokoro clip went through the endpointer: 0 of 43
frames. Before that, three test doubles all passed while the real system
failed — a fake mic pre-loaded with exactly the right frames, a fake speaker
with a truthful `is_playing` the real one did not have, and a fake endpointer
that returned True for any nonzero sample. A passing fake proves the fake.

**Instrument before theorising.** The decisive log line — the follow-up window
opening and closing — was `log.debug` while the service ran at INFO, so the
one fact that would have settled it was invisible for hours. If a hypothesis
cannot be distinguished from its opposite in the log, fix that first.

**Silent failures are the house style here.** A wrong VAD window returns 0.001
instead of erroring; `is_playing` reports False while audio is queued; a full
mic queue drops frames with no consumer; `--devices` shows `0 in` for a device
already open. None raise. Prefer a check that *proves* a thing works over one
that merely fails to complain — which is what `--check`'s VAD test now does.

**Read the warnings already in the log.** `no speech detected in 3.0s` sat in
every turn's output for hours, on turns that transcribed perfectly. It was the
bug, in plain text, dismissed as a level problem.

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
