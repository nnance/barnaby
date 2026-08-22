# The Node agent server — plan

Backlog item 3. A TypeScript server on the Mac Studio that sits between the Pi
and rapid-mlx, becoming the home of tool calling and tier routing later.

The reason it exists is **access, not latency**. A Pi→Mac hop is ~1 ms and
irrelevant next to a TTFT with a 640 ms median. The Pi cannot read the Mac's
files or mail, and tools have to run where the data is.

---

## The contract it must not break

The Pi already speaks this, and phase 1 changes **nothing** on the Pi except one
URL. Taken from `orchestrator/barnaby/clients.py`:

| What | Detail |
|---|---|
| `POST /v1/chat/completions` | `{model, messages, stream: true, max_tokens, temperature, chat_template_kwargs: {enable_thinking: false}}` |
| `GET /v1/models` | `--check` health-checks this. Miss it and `--check` reports the LLM down |
| Response | SSE. `data: {...}\n\n` frames, `choices[0].delta.content`, terminated by `data: [DONE]` |
| Auth | `Authorization: Bearer not-needed` — accept and ignore |
| Client timeout | 60 s |

The Pi reads with `aiter_lines()` and only looks at `delta.content`. It ignores
unknown fields, so extra keys are safe; **missing `[DONE]` is not**.

### Three ways this breaks silently

1. **Buffering.** Sentence-pipelined TTS depends on token-level SSE arriving as
   tokens. Any compression or buffering middleware turns time-to-first-audio
   into full-response latency and nothing *looks* broken — the answer is still
   correct, just late. No compression, `Content-Encoding: identity`, and
   flush every frame.
2. **Dropping `chat_template_kwargs`.** Forward it verbatim or `--no-think` is
   lost, Qwen3 thinks before answering, and TTFT goes back over budget.
3. **Swallowing `[DONE]`.** The Pi's loop `break`s on it. Without it the stream
   hangs until the 60 s timeout.

Phase 1's whole job is to be invisible. The test for "done" is that
`--latency` medians are unchanged.

---

## Shape

```
orchestrator/config.yaml
  llm_url: http://nicks-mac-studio.local:8100/v1   ← the one-line change
        │
        ▼
  agent server :8100  ──passthrough──▶  rapid-mlx :8001
   (asr :8000 and tts :8002 stay direct — off the critical path)
```

ASR and TTS keep talking to rapid-mlx directly. Only the LLM leg moves, so a
broken agent server can never cost you the microphone.

**Port 8100.** Clear of the 8000–8002 rapid-mlx block, so "which thing is on
this port" is never a question.

---

## Dependencies: none at runtime

Node 24.10 is on the Mac (checked). That makes zero-dependency genuinely
achievable rather than an aspiration:

- `node:http` — server. No Express; we serve two routes.
- `fetch` + `ReadableStream` — global since Node 18. Streams upstream SSE with
  backpressure, no `node-fetch`, no `axios`.
- **Type stripping is native** in Node 23+. `node --experimental-strip-types
  src/server.ts` runs TypeScript directly — no build step, no `tsx`, no
  bundler. Types are erased, not checked, which is the right trade here: `tsc
  --noEmit` in `pnpm check` does the checking, and the runtime never sees a
  compiler.

Dev dependencies only: `typescript`, `@types/node`, and Biome to match `face/`.
`pnpm`, not npm — pinned in `devEngines`, same as the face.

If phase 2 needs a dependency it gets argued for on its own merits. The default
is no.

---

## Phase 1 — the passthrough

Boring on purpose. Everything after this rides on it being trustworthy.

**Files**, all under `agent/`:

| File | Job |
|---|---|
| `src/server.ts` | `node:http` server, routes, SSE plumbing |
| `src/upstream.ts` | rapid-mlx client — the only place a URL is built |
| `src/config.ts` | env-var config with defaults |
| `src/log.ts` | one line per turn, structured |
| `package.json` | `dev`, `start`, `check` — no `build` |
| `README.md` | run it, point the Pi at it, what breaks |

**Routes:**

- `POST /v1/chat/completions` — forward body **unmodified** to
  `http://127.0.0.1:8001/v1/chat/completions`, pipe the SSE response back
  byte-for-byte. Non-stream requests pass through as plain JSON, since `curl`
  debugging wants that.
- `GET /v1/models` — proxy upstream so `--check` sees the real model list.
- `GET /healthz` — ours: upstream reachability plus uptime. Not the Pi's path,
  but the thing you curl when the Pi says the LLM is down.

**Passthrough, not reconstruction.** Phase 1 does not parse SSE frames. It
pipes bytes. Parsing is where `[DONE]` gets lost and where framing bugs live,
and there is no reason to pay for it before tool calling needs it. Phase 2
introduces a parser and it gets tested against real captured streams.

**Headers that matter:**

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
Content-Encoding: identity
X-Accel-Buffering: no
```

and `res.flushHeaders()` before the first byte. `no-transform` and `identity`
are the ones that stop a future proxy from helpfully buffering.

**Abort propagation.** When the Pi disconnects mid-turn — barge-in, or a
session ending — abort the upstream fetch. Otherwise rapid-mlx keeps
generating into a socket nobody reads. `res.on('close')` → `AbortController`,
and it must be `res`: `req` emits close as soon as the request body is read,
which is *before* the first token, so hooking it there fires on every healthy
turn and never on a real disconnect. This was written as `req` and was wrong.

**Error behaviour.** If upstream is down, return a **non-streaming** 502 with a
JSON error. The Pi's `raise_for_status()` turns that into a clean exception and
a fault face, which is a better failure than an empty stream that looks like a
model with nothing to say.

**Logging**, one line per request: timestamp, message count, TTFT measured at
the gateway, total duration, upstream status, bytes. That last number is the
buffering canary — if TTFT at the gateway is 350 ms but the Pi sees 900 ms,
something between them is buffering.

### Rollback

Keep the fallback the backlog asks for, and make it free: reverting is editing
`llm_url` back to `:8001` and restarting. Document it at the top of the README.
You will restart this server constantly while developing, and "Barnaby went
mute" gets old.

### Done when

1. `curl -N` against `:8100` streams `data:` frames visibly incrementally —
   watched, not just captured.
2. `python -m barnaby --check` passes with `llm_url` on 8100.
3. A real spoken turn end to end, wake word to speaker.
4. `--latency` medians over ~10 turns are unchanged. **The gate.** Any TTFT
   regression means buffering, and it gets found before anything is built on
   top.
5. Killing the agent server mid-turn produces a clean fault, not a 60 s hang.

---

## Phase 2 — tool calling

Only after phase 1 is dull. It needs the parser phase 1 deliberately skipped,
and it breaks the 2 s budget inherently: a tool turn is two inference rounds
before the first speakable token.

Sketch, to be planned properly when we get there:

- **Parse the upstream stream** into events, accumulate `tool_calls` deltas,
  re-emit content frames downstream unchanged. The parser is what phase 1's
  captured streams become fixtures for.
- **The agent loop lives here**: detect a tool call, run it, append the result,
  call upstream again, stream round two's content to the Pi. The Pi never
  learns this happened — it still sees one SSE stream, which is why the Pi
  needs no further changes.
- **Fill the gap.** ~1.4 s before the tool even runs. The face already goes
  `curious`; a spoken acknowledgement may be wanted. Emitting a first sentence
  during round one is the cheapest option and needs no Pi change.
- **Metrics get new stage marks** per tool round, or the latency table reports
  nonsense — it currently assumes one inference round per turn.
- **Security is the design constraint, not a later pass.** The mic is an attack
  surface: anything the television says can reach real data, and mail flowing
  into the model is prompt injection aimed at your tools. Read-only tools
  first, an explicit allowlist rather than an open plugin surface, confirmation
  for side effects.

Also landing here eventually, noted so phase 1 does not accidentally preclude
them: the **intent matcher** in front of the LLM (keyword match over the
Control 4 device and room list — this is what replaces the tier 0 that HA was
going to supply free), the **Control 4 adapter** behind an intent-shaped tool
interface, and **per-turn routing** between the local model and a frontier one.
Phase 1's passthrough shape allows all three without rework: they are all
decisions made *before* the upstream call.

---

## Deliberately not in phase 1

- **Statelessness stays.** The Pi keeps sending the full message array. A
  session id is a phase 3 conversation at the earliest — a stateless endpoint
  can be debugged with `curl`, and that is worth more right now than saving a
  few hundred tokens per turn.
- **No auth.** Home LAN, and the Pi already sends `Bearer not-needed`. Accept
  and ignore.
- **No system-prompt ownership.** It stays in `pipeline.py`. Moving it is a
  real improvement — it ends the rsync-to-Pi cycle for prompt edits — but it is
  a behaviour change, and phase 1's value is being provably invisible.
- **No service unit yet.** Run it in a terminal while it is being built. It
  earns a `launchd` plist once it is boring, which is the same order the Pi's
  systemd unit came in.
