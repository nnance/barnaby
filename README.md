# Barnaby

Barnaby is a companion robot project that splits the system into a lightweight face interface, a Pi-based orchestration layer, and a future body-control module for the robot's physical motion and lighting. The goal is to keep the robot expressive and responsive while offloading heavier compute to a more capable machine.

At a high level:

- The face is a browser-based front-end built with TypeScript and runs on a small round display.
- The orchestrator is a Python service that manages wake-word detection, speech pipeline, tier routing, and communication with the face.
- The body-control layer will handle head movement, body lighting, and other physical behaviors once the remaining hardware parts are assembled.
- The robot form and physical concept are explored in design documents and an interactive 3D mockup.

## High-level architecture

The system is designed around a split between the local robot hardware and the more capable host machine:

- The Pi handles local audio capture, wake-word detection, websocket coordination, and device control.
- The Mac or other host machine runs inference-heavy tasks such as transcription, LLM response generation, and TTS streaming.
- The face app renders Barnaby's expression and receives state updates over a websocket.
- The body-control module is the next major hardware-facing layer: it will manage head motion, lighting states, and other physical motion effects as the robot body comes together.

This keeps the robot’s display and personality responsive while allowing the intelligence layer to remain flexible and powerful, and it leaves a clear path for the mechanical system to grow into a complete embodied companion.

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
├── orchestrator/                  # Python runtime for the robot brain
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
