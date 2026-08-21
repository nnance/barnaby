# barnaby-orchestrator

Runs on the Pi. Owns the conversation: wake word, endpointing, tier routing,
streaming responses, and the face channel. Everything heavy runs on the Mac
Studio behind OpenAI-compatible HTTP, so this process is almost pure I/O.

```
  mic ─> wake ─> VAD ─> ASR ──> HA Assist ──┬─ matched ─> chirp
                       (Mac)     (tier 0)   └─ no match ─> LLM ─> TTS ─> speaker
                                                          (streamed, sentence by sentence)
```

## Where the latency actually goes

**There is no true streaming ASR.** The OpenAI transcription endpoint takes a
complete file. That is fine — it is not the bottleneck. A 3-second utterance is
~96 KB and Whisper large-v3-turbo on an M3 Ultra runs far faster than real time.
The real wins are elsewhere, in rough order of size:

**1. Tier 0 never touches a model.** "Turn off the kitchen lights" goes to Home
Assistant's Assist agent, matches locally in ~50 ms, and Barnaby chirps. Most
kitchen traffic ends here and never sees an LLM.

**2. TTS is pipelined per sentence.** The LLM is streamed, split into sentences
on the fly, and each sentence is sent to TTS *without awaiting the previous
one*. Sentence one plays while sentence three is still being generated. This
decouples time-to-first-audio from answer length — a long answer starts as fast
as a short one. Largest single win in the system.

**3. The first sentence is deliberately cut short.** It flushes at the first
clause boundary past 24 characters, so *"It's twenty two degrees outside,"*
starts playing while the rest is still arriving. Later sentences use normal
boundaries.

**4. Endpointing is aggressive.** `hangover_ms: 350`. Waiting 800 ms of silence
before deciding someone finished adds 800 ms to every turn. If it clips
someone, their next words arrive as a follow-up rather than being lost.

**5. Chirp instead of narration.** A device command gets two descending notes,
not four seconds of TTS explaining what you already watched happen.

Every turn prints a stage-by-stage table with a verdict against the budget:

```
turn [tier0] 'turn off the kitchen lights'
  wake -> endpoint            4.1 ms
  endpoint -> asr_sent        2.2 ms
  asr_sent -> asr_done       18.2 ms
  asr_done -> tier0_done      5.0 ms
  PERCEIVED (endpoint -> audio)  25.5 ms   budget 700  OK
```

## Setup

On the **Mac** — three instances, since Rapid-MLX serves one model each:

```bash
pip install 'rapid-mlx[audio]'
rapid-mlx serve whisper-large-v3-turbo --port 8000
rapid-mlx serve qwen3.8-27b-4bit       --port 8001 --no-think
rapid-mlx serve kokoro                 --port 8002
```

`--no-think` is not optional. Qwen3.x defaults to thinking-on, and
chain-of-thought before a light switch blows the budget many times over.

On the **Pi**:

```bash
sudo apt install portaudio19-dev libsndfile1   # sounddevice/soundfile need these
uv venv && uv pip install -e .
export HA_TOKEN=...            # long-lived token from your HA profile
python -m barnaby --devices    # find the XVF3800, put its index in config.yaml
python -m barnaby --check      # confirm all four services are reachable
python -m barnaby
```

Point the face at it: `npm run dev` in `barnaby-face`, then
`http://localhost:5273/?ws=ws://barnaby.local:8711/face`.

## Talking to it before the wake word exists

`models/barnaby.onnx` does not exist yet — it has to be trained. Until then
there are three ways in, in increasing order of realism:

**No microphone at all.** Exercises tier routing, LLM streaming, pipelined TTS,
playback and the face channel:

```bash
python -m barnaby --say "what's the weather like?"
```

**Open mic — just talk.** No wake word; any sustained speech starts a turn.
This is the fastest way to have a real conversation today:

```bash
python -m barnaby --open-mic
```

It will happily answer the television, so it is a test mode, not a way to live
with him.

**A borrowed wake word.** openWakeWord ships pretrained models. Set
`wake.model: hey_jarvis` in `config.yaml` after downloading them:

```bash
python -c "import openwakeword.utils as u; u.download_models()"
```

Everything downstream is identical — only the trigger differs — so latency
numbers measured this way are real.

## Tuning

| Symptom | Knob |
|---|---|
| Cuts you off mid-sentence | `hangover_ms` up to 500 |
| Feels sluggish to respond | `hangover_ms` down to 250 |
| First word of every turn missing | `preroll_ms` up |
| TV triggers the wake word | `wake.threshold` up to 0.6–0.7 |
| Interrupts itself while speaking | `barge_in_ms` up; verify the array's AEC is on |
| Device commands feel slow | check tier 0 is matching — `--verbose` shows escalations |

## Things that will bite

**Load models before opening the mic.** Already done in `__main__`, but if you
add one, warm it at startup. A cold model on the first utterance is the first
thing anyone notices.

**Barge-in depends on hardware AEC.** It is only trustworthy because the
XVF3800 cancels Barnaby's own voice. Without it he hears himself and interrupts
himself constantly.

**No HA token means no tier 0.** Everything escalates to the LLM and device
commands feel slow. The startup log warns about this.

**Faults outrank moods.** The face's `set_fault` overrides `set_mood`; a fault
indicator a good mood can mask is useless.

## Not yet wired

- **Camera and face tracking.** The `look` message exists on the face channel
  and nothing sends it yet. Needs the Camera Module 3 Wide.
- **Tool calling.** Tier 1 answers but cannot yet act. Next piece of work, and
  the thing to benchmark on the local model — small models are noticeably less
  reliable at multi-step tool use than frontier ones.
- **Identity.** No face or voice recognition, so personal data is off limits.
  The system prompt says so; enforcement belongs in the tool layer.
- **ESP32 link.** Servos, body glow, touch and IMU.
