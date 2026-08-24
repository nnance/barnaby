# Barnaby

Barnaby is a companion robot, and the split that matters is not between
hardware and software — it is between **the agent** and **the interfaces to it**.

**The agent is the AI system.** It runs on the Mac Studio, owns the model, the
tools, the system prompt, and what it knows about the household, and it is
multimodal by design. It has no idea whether the thing asking it a question has
a speaker, a screen, or neither.

**The robot is an interface.** It is how a person reaches the agent from the
kitchen counter, using whichever modes are available to it: **voice in** through
the microphone array, **sound out** through the speaker, **a face** on the round
display, and **vision** through the camera when it arrives. Motion — the head
turning toward you — is another output mode, not a separate system.

The robot is the first interface, not the only possible one. A web chat, a phone,
or another room's device would be a different interface to the same agent, and
would need no change to it.

## Why the boundary sits there

Two things follow from it, and both are load-bearing:

**Tools run where the data is.** A Pi cannot read the Mac's files or mail. That
is why the agent loop lives on the Mac — access, not latency. The hop between
them is about a millisecond and irrelevant.

**The interface owns presentation; the agent owns everything else.** The robot
knows its answers are spoken aloud through a speaker with no screen, so it asks
for short replies, no markdown, and numbers said the way people say them. A web
chat would ask for the opposite. Neither is the agent's business, so a client's
system prompt is *appended* to the agent's rather than replacing it. The agent
supplies who Barnaby is; the interface supplies how to say it.

The same forecast, from the same agent and the same tool, reaches a speaker as
"a hundred and two degrees" and a web chat as a markdown table.

## The pieces

| Piece | Runs on | What it is |
|---|---|---|
| **`agent/`** | Mac Studio | The AI system. Model, tools, prompt, household context. TypeScript, no runtime dependencies |
| **`orchestrator/`** | Pi 5 | The robot interface. Wake word, capture, endpointing, playback, face channel. Python |
| **`face/`** | Pi 5 → 480×480 panel | The expression. Browser-based, driven over a websocket |
| **firmware** | ESP32-S3 (not built) | Head motion, body glow, touch. Another output mode |
| rapid-mlx | Mac Studio | ASR, LLM and TTS servers the agent and robot call |

The Pi keeps everything real-time and hardware-adjacent — audio capture, wake
word, endpointing, playback, barge-in — because those need to be close to the
microphone. Everything about *intelligence* is on the other side of the boundary.

## What a turn looks like

```
you speak
   │
   ▼
robot interface (Pi)          wake word → capture → endpoint
   │                          asks ASR for a transcript
   ▼
agent (Mac)                   its own prompt + household context
   │                          + the robot's "spoken aloud" guidance
   ├── needs a tool? ──────▶  runs it here, feeds the result back
   ▼
robot interface (Pi)          sentence-by-sentence TTS → speaker
                              face reacts, head turns
```

The robot never learns whether a tool ran. It sends a transcript and receives one
stream of sentences, which is exactly why adding tool calling required no change
to it at all.

## Project structure

```text
barnaby/
├── README.md                     # project overview
├── DESIGN.md                     # high-level robot design and system thinking
├── PARTS.md                      # mechanical and fabrication notes
├── docs/
│   └── companion-robot-3d.html  # interactive concept model of the robot form
├── face/                         # browser-based face application
│   ├── README.md                 # build/run instructions for the face UI
│   ├── package.json
│   ├── src/
│   └── ...
├── agent/                        # the AI system — model, tools, prompt (TypeScript)
│   ├── README.md                 # running it, and what breaks silently
│   ├── docs/plans/archive/       # finished plans — history, not instruction
│   ├── CONTEXT.example.md        # template for the household context
│   ├── src/tools/                # the tool registry and its tools
│   └── ...
├── orchestrator/                  # the robot interface — audio, wake word, face
│   ├── README.md                 # setup and execution guide for the orchestrator
│   ├── pyproject.toml
│   ├── config.yaml
│   ├── __main__.py
│   └── ...
├── body-control/                 # planned module for head motion, body lighting, and motion logic
│   └── (to be implemented)
└── .gitignore
```

## Components

### Face UI

The face app is the visual layer of the robot. It renders Barnaby’s state, gaze, mood, alert conditions, and body glow as a compact, kiosk-friendly interface.

See:
- [face/README.md](face/README.md)

### Orchestrator

The orchestrator is the control system that ties together wake-word detection, microphone input, speech processing, wake-word routing, and message delivery to the face.

See:
- [orchestrator/README.md](orchestrator/README.md)

### Body control

The body-control layer is the major unfinished component of the system. Once the remaining body parts and electronics are assembled, this module will coordinate head movement, body lighting, servo control, and physical state changes in response to the orchestrator and face state.

This module is intentionally represented as a planned extension rather than a completed implementation, because the mechanical and electrical kit is still being assembled and integrated. In the finished system, it will sit alongside the face and orchestrator as the hardware-facing motion and lighting controller.

## Interactive robot design page

The concept art and form exploration are available in an interactive virtual page that lets you inspect the recessed vs. exposed head variations and adjust the motion model.

Open the interactive design page here:
- [docs/companion-robot-3d.html](docs/companion-robot-3d.html)

This is a useful reference when evaluating the physical structure, proportions, and head mechanism before committing to fabrication or control work.

## Design references

- [DESIGN.md](DESIGN.md) — design narrative and overall product direction.
- [PARTS.md](PARTS.md) — part-level and fabrication notes.

## Build and run

For the detailed local setup, execution, and deployment steps, follow the component-specific documentation:

1. Face application: [face/README.md](face/README.md)
2. Robot orchestrator: [orchestrator/README.md](orchestrator/README.md)

Together, these two documents describe how to install dependencies, start each service, and wire the face to the orchestrator.
