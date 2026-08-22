# Barnaby — Audio Wiring and Bring-Up

Getting sound in and out of the Pi, from "nothing plugged in" to "he answers you".

**There is no wiring.** The ReSpeaker has its own amplifier and speaker
connector, so mic and speaker both hang off the single USB port. Stage 2 exists
only as a fallback you probably won't need.

---

## Stage 1 — Zero wiring, and it's also the right answer

**Everything goes through the ReSpeaker.** One USB port, no GPIO, no soldering.

The XVF3800 is not just a microphone — it has an **onboard amplifier**, a 2-pin
JST speaker connector and a 3.5 mm jack, and supports 5 W speakers. Your 5 W 8 Ω
double-cavity units are exactly what it is rated for.

```
Pi ──USB── ReSpeaker XVF3800 ──JST── 5 W 8 Ω speaker
```

### Why this beats a separate amplifier

Not port economics — **echo cancellation**.

AEC works by subtracting what is being played from what the mics hear, which
requires a reference of the playback signal. When audio leaves through the
array's own output, that reference is internal and perfectly time-aligned. Route
it through a separate MAX98357A and the array is guessing at gain and delay —
AEC degrades, and barge-in stops working. Barge-in was the whole reason to
choose this array over something cheaper.

Seeed confirm the coupling: they document tuning `AUDIO_MGR_REF_GAIN` and
`AUDIO_MGR_SYS_DELAY` specifically for poor AEC when driving a speaker from the
3.5 mm output.

**Use the JST speaker connector, not the 3.5 mm jack.** The speaker connector
feeds the onboard amp directly; the jack is a line-level path Seeed flag as more
AEC-sensitive.

### Connector

Your speakers terminate in JST-PH 2.5 mm. Check the pitch against the board's
connector before forcing anything — JST-PH is normally 2.0 mm, so the listing
may be loose with terminology. If they don't mate, cut the connector and fit a
pigtail matching the board. Polarity is irrelevant for a single driver.

### Two settings this determines

**Playback device is the ReSpeaker**, same device as capture. It presents both
capture and playback endpoints over USB.

**Sample rate is 16 kHz, not 24.** The XVF3800 caps at 16 kHz. Kokoro renders at
24 kHz, so the TTS client resamples — set `playback_rate: 16000` and it handles
the conversion.

### Verify

```bash
lsusb                       # the array should appear
arecord -l && aplay -l      # it should be in BOTH lists
python -m barnaby --devices # indices for config.yaml
speaker-test -c1 -twav -D plughw:1,0
```

### If it's quiet or distorts at volume

The array can run from USB bus power or external 5 V. Driving a 5 W speaker from
a USB port's current budget is marginal. If output is weak or breaks up on
peaks, that is a power problem, not a volume setting — feed the board external
5 V.

### Which variant do you have

The XVF3800 ships in USB and I2S firmware variants. If `lsusb` shows nothing,
you have the I2S build, not a dead board — it needs reflashing via DFU or an
MCU host.

## Interim — Waveshare USB card for output

Two USB devices, no wiring, works today. Both are USB Audio Class, so nothing
to install.

```
Pi ──USB── ReSpeaker XVF3800   (capture)
Pi ──USB── Waveshare card ──── speaker   (playback)
```

```yaml
audio:
  input_device: <ReSpeaker index>
  output_device: <Waveshare index>
  barge_in_enabled: false     # no AEC reference on a separate output
  playback_rate: 24000        # 48000 if sounddevice rejects 24k
```

**Barge-in is off, and must be.** The array's echo canceller can only subtract
audio it played itself. With output on a different device it has no reference,
so Barnaby hears his own voice and interrupts himself mid-sentence. Leave it off
until the speaker moves onto the array.

Everything else is identical, so latency measured this way is real.

### Switching back once the pigtail arrives

```yaml
  output_device: <ReSpeaker index>   # same device as input
  barge_in_enabled: true
  playback_rate: 16000               # XVF3800 caps at 16 kHz
```

All three change together. Miss `playback_rate` and everything plays at the
wrong pitch and speed, which is a confusing thing to debug.

---

## The channel gotcha

**The array does not present a mono stream.** Like most XMOS arrays it exposes
several channels — typically:

| Channel | Contents |
|---|---|
| 0 | Beamformed, echo-cancelled, noise-suppressed — **use this one** |
| 1..n | Raw per-capsule feeds |
| last | Playback loopback reference (on some firmware) |

Open it as mono and you either get an error or, worse, one raw capsule with no
AEC — which presents as "barge-in doesn't work" and sends you debugging the
wrong thing entirely.

The orchestrator opens the device at its native channel count and takes one:

```yaml
audio:
  input_channels: null   # null = whatever the device reports
  input_channel: 0       # the processed output
```

Confirm what you actually have:

```bash
python -c "import sounddevice as sd; print(sd.query_devices())"
```

If speech recognition is poor *and* barge-in triggers on Barnaby's own voice,
you are almost certainly on a raw channel. Try 0 first, then walk upward.

---

## Stage 2 — MAX98357A over I2S (probably not needed)

Keep this only as a fallback if the array's amp turns out too quiet for a
kitchen. It costs you the AEC reference, so try external 5 V on the array
first. The other use for these boards is driving chirps from the ESP32,
independent of the Pi.


Better than the USB card: roughly double the output, better SNR, no USB port
consumed. Five wires, no soldering to the Pi.

| MAX98357A | Pi GPIO | Physical pin |
|---|---|---|
| BCLK | GPIO18 | 12 |
| LRC | GPIO19 | 35 |
| DIN | GPIO21 | 40 |
| Vin | 5V | 4 |
| GND | GND | 6 |

Then in `/boot/firmware/config.txt`:

```
dtparam=i2s=on
dtoverlay=hifiberry-dac
```

Reboot, and `aplay -l` should list a new card. If `hifiberry-dac` doesn't take
on your kernel, try `dtoverlay=max98357a` — both exist, availability varies by
kernel version. Test with `speaker-test -c2 -twav -D hw:CARD=sndrpihifiberry`.

### The two pads that catch people out

**SD_MODE selects the channel, and floating may mean silence.** It is compared
against internal thresholds:

| Voltage on SD | Behaviour |
|---|---|
| below 0.16 V | shut down — no output at all |
| 0.16–0.77 V | right channel only |
| 0.77–1.4 V | **(left + right) / 2 — what you want for mono** |
| above 1.4 V | left channel only |

Generic breakouts vary in what they fit on that pin. Leave it alone first; if
you get silence or only hear one side of a stereo test, that's SD. Tie it to
3.3 V through a resistor divider landing in the 0.77–1.4 V band, or straight to
3.3 V to force left.

**GAIN sets output level.** Floating is 9 dB. For maximum volume — which you
will want in a kitchen — fit **100 kΩ from GAIN to GND for 15 dB**. Straight to
GND is 12 dB, straight to Vin is 6 dB.

### Speaker connection

Your 5 W 8 Ω double-cavity units terminate in **JST-PH 2.5 mm**. The amp has
screw terminals or pads, so either buy a matching pigtail or cut the connector
off. Polarity doesn't matter for a single driver.

Use the **enclosed** speakers, not the bare 40 mm Gikfun drivers — the factory
cavity is why you don't have to design an acoustic chamber, and a bare driver
in an open printed shell buzzes around 350 Hz and couples vibration into the
mic array, which degrades echo cancellation.

### Power

For bench testing, 5 V off pin 4 is fine. **For the build, feed the amp from
the separate 5.1 V buck rail, not the Pi's header.** Class-D current spikes on
transients are a classic cause of Pi brownouts that look like random reboots.

---

## Bring-up order

Riskiest first, so you find problems while the bench is still simple.

```bash
# 1. Are the Mac services and HA reachable?
python -m barnaby --check

# 2. Audio out only — no mic involved
python -m barnaby --say "hello, I am Barnaby"

# 3. Full conversation, no wake word needed
python -m barnaby --open-mic

# 4. With a wake word, once you have a model
python -m barnaby
```

If step 2 is silent, it is wiring or `output_device`. If step 3 hears nothing,
it is `input_device` or `input_channel`. Keeping those separate saves hours.

---

## System packages

`sounddevice` and `soundfile` are thin wrappers over C libraries that pip will
not install for you:

```bash
sudo apt install portaudio19-dev libsndfile1
```

Missing PortAudio fails at import with `OSError: PortAudio library not found`.

---

## Symptom table

| Symptom | Likely cause |
|---|---|
| `PortAudio library not found` | `apt install portaudio19-dev` |
| No card after I2S wiring | overlay not applied, or wrong pin — recheck 12/35/40 |
| Silence but the card exists | SD_MODE pad; also check `alsamixer` isn't muted |
| Only one channel audible | SD_MODE selecting left or right instead of the average |
| Too quiet | GAIN pad — 100 kΩ to GND for 15 dB |
| Buzzes at low frequencies | bare driver with no enclosure; use the double-cavity units |
| Barge-in fires on his own voice | wrong input channel, or playback isn't going through the array — AEC has no reference |
| Weak or distorted at volume | array on USB bus power; feed it external 5 V |
| Playback device missing | check `aplay -l` — the array should appear in BOTH aplay and arecord |
| Random reboots when speaking | amp drawing from the Pi header; move it to the buck rail |
| Speech recognition poor | wrong input channel, or `input_channel` past the processed one |
