# Barnaby — Raspberry Pi Setup

From a blank SD card to a conversation. About an hour, most of it waiting on
downloads.

**Order matters: playback, then capture, then conversation.** You verify a
recording by playing it back — start with capture and you are judging success by
staring at file sizes. Get sound *out* first and everything after it becomes
testable.

---

## 1. Flash the card

**Raspberry Pi OS (64-bit) Lite**, Bookworm or later. Lite, not Desktop — the
face renders on your laptop for now, and a desktop is dead weight on an
appliance. The kiosk browser runs fine on Lite when the panel arrives.

In Raspberry Pi Imager, open the settings gear before writing:

| Setting | Value |
|---|---|
| Hostname | `barnaby` |
| Enable SSH | yes, public-key if you have one |
| Username | your choice |
| Wi-Fi | configure it, but see below |
| Locale / timezone | set it — timestamps in the latency logs matter |

**Use Ethernet if you possibly can.** Every turn ships audio to the Mac and
gets audio back. Wi-Fi jitter lands directly on your latency floor, and it is
the hardest kind of variance to debug later.

An SD card is fine for this stage. Move to the NVMe before Barnaby lives on the
counter — continuous logging kills SD cards in months, and it fails at 6 a.m.
on a weekday.

## 2. First boot

```bash
ssh barnaby.local
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

Then the system libraries. `sounddevice` and `soundfile` are thin wrappers over
C libraries that pip will not install for you:

```bash
sudo apt install -y portaudio19-dev libsndfile1 python3-dev git
```

Missing PortAudio fails at import with `OSError: PortAudio library not found`,
which is a confusing first error.

## 3. Python

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
```

Copy the orchestrator over from your laptop:

```bash
rsync -a barnaby-orchestrator/ barnaby.local:~/barnaby/
```

Then on the Pi:

```bash
cd ~/barnaby
uv venv && source .venv/bin/activate
uv pip install -e .
```

No torch, no tensorflow. The VAD is a 2 MB `.onnx` fetched on first run and
cached in `~/.cache/barnaby/`, executed directly by onnxruntime.

**The wake word is a separate extra and needs Python 3.11 or 3.12.** Recent Pi
OS ships 3.13, and openwakeword hard-depends on `tflite-runtime`, which has no
cp313 wheels — you get `No solution found when resolving dependencies`. When you
want a wake word:

```bash
uv venv --python 3.11        # uv downloads a standalone build
source .venv/bin/activate
uv pip install -e '.[wake]'
```

Not needed to start. `--open-mic` and `--say` are fine on 3.13.

---

## 4. Playback first

Plug in **only the Waveshare card** for now. One device, one variable.

```bash
aplay -l
```

Note the card and device numbers, e.g. `card 1: Device`, `device 0`.

```bash
speaker-test -c1 -twav -l1 -D plughw:1,0
```

You should hear "front centre". If not:

```bash
alsamixer          # F6 to pick the card, arrow up, M to unmute
```

USB cards very often boot muted or at zero. Check this before suspecting
anything else.

## 5. Then capture

Now plug the ReSpeaker in as well.

```bash
arecord -l                 # the array should appear
lsusb                      # confirms it enumerated
```

If `lsusb` shows nothing, you have the I2S firmware variant of the XVF3800, not
a dead board.

Record and play it back — this is why playback came first:

```bash
arecord -D plughw:2,0 -f S16_LE -r 16000 -c 6 -d 5 /tmp/t.wav
aplay -D plughw:1,0 /tmp/t.wav
```

**Note `-c 6`.** The array is not mono. Like most XMOS arrays it exposes several
channels — channel 0 is the beamformed, echo-cancelled output and the rest are
raw capsules. If `-c 6` errors, try `-c 2` or `-c 4`; the error message names the
supported count.

## 6. Tell Barnaby which devices to use

```bash
python -m barnaby --devices
```

Put both in `config.yaml`. **Set them explicitly** — the Waveshare card probably
has a capture endpoint too, and leaving `input_device: null` may silently pick a
bare mic with no beamforming. You would get a working pipeline that transcribes
badly and spend the evening blaming Whisper.

Substring names survive reboots better than indices, which shift as USB devices
enumerate:

```yaml
audio:
  input_device: "ReSpeaker"
  output_device: "Waveshare"
  input_channel: 0
  barge_in_enabled: false
  playback_rate: 24000
```

The startup log prints which device it opened and how many channels. Glance at
those two lines before anything else.

## 7. Conversation

```bash
export HA_TOKEN=...              # long-lived token from your HA profile
python -m barnaby --check        # are the Mac services and HA reachable?
python -m barnaby --say "hello, I am Barnaby"
python -m barnaby --open-mic     # no wake word needed
```

Keep `--say` and `--open-mic` as separate steps. Silence at `--say` is output;
silence at `--open-mic` is input. Debugging both together is where the evening
goes.

Point the face at him from your laptop:

```
http://localhost:5273/?ws=ws://barnaby.local:8711/face
```

---

## What to look at first

Every turn prints a latency table. The line that matters most is
**`endpoint -> asr_done`** — Whisper on the M3 Ultra plus the LAN round trip.
Everything else in the budget can be reasoned about; that one has to be
measured, and it decides whether local ASR is viable or you need to rethink.

If `PERCEIVED` is over budget, the table tells you which stage to attack. Do not
tune blind.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `PortAudio library not found` | `apt install portaudio19-dev` |
| `speaker-test` silent | muted or zero volume — `alsamixer`, F6, unmute |
| `arecord` says channels unavailable | array is multi-channel; raise `-c` |
| Transcription is poor | wrong `input_device`, or `input_channel` past ch0 |
| Barnaby interrupts himself | expected on a separate output — `barge_in_enabled: false` |
| Everything sounds slow or deep | `playback_rate` mismatch. 24000 on the USB card, 16000 on the array |
| `--check` shows services down | Rapid-MLX not running, or wrong host in `config.yaml` |
| Wake word won't load | expected — no model yet. Use `--open-mic` |
| `No solution found` on install | Python 3.13 vs openwakeword. Core install omits it; use `--python 3.11` for the `[wake]` extra |
| Random reboots | power. Use the official 27 W supply |

## When the pigtail arrives

Three settings move together:

```yaml
  output_device: "ReSpeaker"   # same device as input
  barge_in_enabled: true       # AEC now has its reference
  playback_rate: 16000         # the XVF3800 caps here
```

Miss the last one and everything plays at the wrong pitch and speed.
