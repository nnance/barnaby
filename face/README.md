# barnaby-face

Barnaby's face. TypeScript → Canvas 2D, rendered at 480×480 on a 2.1″ round IPS
panel over HDMI (micro at the Pi end).

The face is a **pure view**. It owns no policy — the orchestrator decides that a
fault outranks a mood, that sleep follows idle, when to look at someone. This
draws what it's told, and keeps drawing when it's told nothing.

```bash
pnpm install
pnpm dev             # http://localhost:5273  — dev tools on automatically
pnpm check:fit       # geometry regression — must pass before build
pnpm build           # → dist/, ~8 kB JS
```

Dev tools are on by default under `pnpm dev` and stripped from a production
build. **Move your pointer** and Barnaby's eyes follow it — that's what the face
tracker will drive. Number keys `1`–`0` switch states. A body-glow swatch shows
the colour the ESP32 would be sent.

`?dev=0` previews exactly what the kiosk shows: no panel, no cursor.

## The panel constraint

The active area is a **53 mm circle — 26.5 mm of usable radius**. Anything
beyond that is physically not there. All geometry is authored in millimetres in
`src/layout.ts` and `src/expressions.ts`, and `MM` converts to pixels.

`pnpm check:fit` samples the **actual drawn outline** — rounded-corner arcs
on the eyes, rotated brow corners, worst-case idle drift and tracked gaze
pushing the same direction at once — and fails if anything exceeds the radius.
This is not decorative. Two expressions were silently clipping before it
existed, and a bounding-box approximation of the "happy" arc was wrong by
several millimetres. **Run it after any layout edit.**

Idle drift and tracked gaze are **clamped as a combined offset** (`maxDX`,
`maxDY`) rather than summed. Without that cap the two stack, the worst case eats
the margin, and gaze has to be timid to stay safe. Clamping lets gaze be
generous while the geometry stays guaranteed.

Current worst case: `surprise` at 25.2 mm, 1.3 mm of margin.

## Protocol

WebSocket to the orchestrator, default `ws://<host>:8711/face`. Override with
`?ws=`. Every message is validated at runtime — a typo upstream logs a warning
and is ignored, never throws.

```jsonc
{ "type": "state", "name": "listening" }   // any key of STATES
{ "type": "look",  "x": -0.4, "y": 0.2 }   // -1..1, from the face tracker
```

On disconnect the face **keeps its last state and keeps blinking**, reconnecting
with backoff to 5 s. An orchestrator restart must not blank Barnaby's face.

## States

Six moods — `neutral` `happy` `curious` `surprise` `listening` `sleepy` — plus
`boot` and three faults.

**Faults override mood.** `offline`, `haDown` and `muted` are not moods and must
not be maskable by one; a fault indicator a good mood can hide is useless.
`muted` is deliberately unmistakable: eyes shut, no drift, no glow. It's a
privacy indicator, not an expression.

## Body glow

`STATES[name].glow` is the **single source of truth** for the LED ring colour.
The orchestrator reads it here and forwards it to the ESP32, so the ring and the
face can never disagree about Barnaby's mood.

## Shape swaps hide inside a blink

Eye shapes can't be interpolated — a rounded rect can't morph into an arc. So
changing expression triggers a blink and swaps the geometry at the midpoint,
while the eyes are shut. Same cut-hiding trick animators use. Everything else
(brow height, tilt, asymmetry, gaze scale) interpolates normally.

## Deploying to the Pi

```bash
./deploy-face.sh              # build, rsync, restart the kiosk
./deploy-face.sh --install    # first time: also installs cog and the units
./deploy-face.sh --logs       # ... then follow the kiosk log
```

From the repo root, and the sibling of `./deploy.sh` — same conventions, same
reason. It builds here and ships `dist/`; the Pi never runs pnpm, tsc or vite.
Because `build` runs `check:fit`, a layout change that would clip off the round
panel fails on your machine rather than deploying geometry the display cannot
show.

Two **user** units (`systemctl --user`, never sudo): `barnaby-face-server`
serves `dist/` on `127.0.0.1:8080`, and `barnaby-kiosk` runs **`cog`** (WPE
WebKit) straight to DRM/KMS — a real embedded runtime, no X, no desktop, no tab
bar. The kiosk deliberately does **not** depend on `barnaby.service`: the face
survives the orchestrator restarting, so ordering it behind the orchestrator
would only blank the panel exactly when you want to see a face.

**`--install` does not set the video mode.** 480×480 is non-standard, lives in
`cmdline.txt`, and needs sudo and a reboot. That, plus which HDMI port, which
cable, and why the panel needs its own USB power, is
**[docs/display-setup.md](../docs/display-setup.md)** — do it once before any
of this will show anything.

## Layout

```
src/expressions.ts   state table + eye geometry. Edit expressions here.
src/layout.ts        shared mm constants. Edit proportions here.
src/face.ts          canvas renderer, blink and drift timing.
src/transport.ts     websocket + runtime validation.
src/main.ts          wiring + dev panel.
src/check-fit.ts     geometry regression check.
```
