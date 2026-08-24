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

---

## Phase 2 — measured

Built 2026-08-23. The loop runs upstream rounds until the model stops asking
for tools; the Pi still sees one SSE stream ending in one `[DONE]`, so it needed
no change at all.

**The gap is real and it is worse than the estimate.** Measured against the live
model, four turns:

```
tool_gap = 1031, 1069, 1084, 1350 ms      (first tool dispatch -> next content token)
time to first audio  ~1.9-2.5 s           against a 2000 ms budget
non-tool turn        ~425 ms, unchanged
```

`--say`-style turns and any turn that uses no tool are untouched: with an empty
registry the gateway falls through to phase 1's byte pipe, and with a registry
a tool-less turn is a single round.

**What the gap actually contains**, roughly: ~450 ms for round one to decide,
~580 ms in Open-Meteo, and the rest re-prefilling round two. The tool call is
the smallest part of the wait, so caching the forecast would buy less than it
looks — round-two prefill is the target.

**Two problems this surfaced, both still open:**

1. **The model narrates.** It says "Let me check the forecast for you." in round
   one, which is spoken, and then the real answer arrives a second later as a
   separate sentence. It reads as an accidental filler phrase — the very thing
   deliberately not built. It is not free: it is the whole `first_sentence`
   pipeline speaking a line with no content in it. Either lean into it (make it
   deliberate and short) or suppress round-one content entirely when tools are
   on offer, which trades the gap back to silence.
2. **A promise with nothing behind it — and it is routine, not rare.** Round
   one often says it will check and then calls nothing. Earlier notes called
   this nondeterministic on the strength of 8/8 clean probes; live traffic says
   otherwise, with `rounds=3` on two of three turns. That is a wasted inference
   round, ~1.5 s, on most weather questions.

   The nudge handles it: the held promise is dropped and the model is asked
   again. It costs the round but the user hears only the answer. The real fix is
   whatever stops round one stalling in the first place, which is the same
   problem as item 1.


---

## The alias, and the 300 ms that was never the gateway's fault

Chasing a plain-chat regression to its end, through three wrong answers.

**What was blamed, and was innocent.** First the prompt composition (it costs
79 ms). Then the gateway (measured against a payload without tools, which was
not a fair comparison — with identical payloads, direct and gateway match, and
an in-process profiler put serialisation at 0 ms and first byte at 60 ms).

**What it actually was.** Declaring tools cost a flat ~335 ms per turn, whether
or not a tool was used, and no amount of repetition warmed it up. Trimming the
schema by half bought 43 ms, so it was not token count.

**Why.** rapid-mlx enables prefix caching by default, and it was doing nothing:

```
rapid_mlx_prefix_cache_hits_total     0
rapid_mlx_prefix_cache_misses_total 351
rapid_mlx_prefix_cache_tokens_saved    0
```

The features are switched on by `model_auto_config`, which keys off a **rapid-mlx
alias**. We were serving `lmstudio-community/Qwen3.6-35B-A3B-MLX-8bit` — a raw
HuggingFace path — so the profile never resolved, and neither the prefix cache
nor TurboQuant KV compression ever engaged.

Serving `qwen3.6-35b-8bit` instead resolves the profile, and the log says so:

```
Resolved alias profile ... turboquant_tier=k8v4_verified
TurboQuant default: engine defaults to --kv-cache-turboquant k8v4
MemoryAwarePrefixCache initialized: max_memory=11186.2MB, radix_index=on
```

| | raw path | alias |
|---|---|---|
| Tool turn TTFT | 468 ms, never improves | **179 ms** |
| Plain chat TTFT | 133 ms | **77 ms** |
| Prefix cache | 0 hits / 351 misses | **27 hits, 21,407 tokens saved** |
| Gateway `tool_gap` | ~1300 ms | **~500 ms** |

Tool calling is unaffected: 12/12 exact coordinates on the alias, same as before.

**The lesson, and it is in CLAUDE.md now: serve by alias, never by path.** A raw
path works, answers correctly, and quietly costs you every optimisation the
server has. `rapid-mlx models` lists the aliases.


---

## The clock, and a bug that is not fixed yet

**The problem.** The model does not know the date, and it does not know that it
does not know. Asked what day it was on a Sunday it said "Tuesday". Asked for
Friday's forecast it returned Tuesday's numbers — the weather tool's ISO dates
were correct throughout, and the model was mislabelling them onto weekday names.

**Why it is a tool and not a line in the system prompt.** A prompt carrying the
current time changes every minute, so it would never match a cached prefix.
rapid-mlx's prefix cache is worth ~300 ms a turn here, and a clock in the prompt
would quietly spend all of it. `systemPrompt()` is asserted to be stable between
calls, and to contain no date, so this cannot creep back in.

The definition is deliberately tiny — under 300 bytes, asserted — because every
schema is sent on every turn and declaring tools at all already costs real time.

**What works:** the tool returns the right answer
(`{"date":"2026-08-23","weekday":"Sunday",...}`) in the household's timezone, and
the model uses it correctly when it is handed the result — "It is Sunday, August
23, 2026."

**What does not:** the model rarely calls it. Weather questions produce
`tools=get_forecast` alone, so "Friday" still gets Tuesday's numbers. Three
descriptions were tried:

| Description | Result |
|---|---|
| "Call this before working out what a day refers to" | Not called on "what day is it" |
| "You do not know these; you must call this tool..." | Leaked the tool name into speech |
| "Use this tool when you need the current date or time" | Clean, still not called |

The second is worth noting as a general lesson: an emphatic, unusual description
made the model *narrate the tool name aloud*. Plain wording behaves better even
when it does not solve the problem.

**The fix: label the rows.** Two attempts missed before the right one landed.

A `start_date` parameter was tried and rejected — it put the arithmetic back on
the model, which is the thing that was broken. Then `today` was added to the
forecast output as an anchor, on the theory that the model only lacked a
reference point. Measured: **2/6 correct before, 3/6 after** — noise. The payload
already contained correct ISO dates and now contained today's date too, and the
model still answered Friday with Tuesday's numbers.

That ruled out the whole class of fix. It was never missing data; the model
simply cannot reliably compute that Friday is the 28th when today is Sunday the
23rd.

So it is no longer asked to. **Every forecast day now carries its weekday**, and
matching "Friday" to a row labelled `Friday` needs no arithmetic at all:

```json
{ "date": "2026-08-28", "weekday": "Friday", "temperature_max": 107.6 }
```

| | correct | mislabelled |
|---|---|---|
| ISO dates only | 2/6 | 4/6 |
| plus `today` anchor | 3/6 | 3/6 |
| **plus weekday labels** | **10/12** | **0/12** |

The two misses are a different and much better failure: the model asked for too
few days and then said "I don't have the forecast for Saturday" rather than
inventing one. Nothing is mislabelled any more.

`today` is kept. It did not fix this on its own, but it is correct data, and
it is what tells the model which labelled row is the current one.

**The lesson.** Three descriptions of the clock tool were tried before this, and
none worked, because the problem was never that the model lacked the date — it
was being asked to do arithmetic it is bad at. Moving the work into the tool
output beat every attempt to describe the problem more emphatically.


## Telling the model it does not know the date

The clock tool worked and the model would not call it. Asked "what day is it"
it answered "It is currently Monday" from training data — **0/10 tool calls**
with the live prompt.

A long detour was spent on the wrong hypotheses. Whether the tool was actually
on the wire (it was — verified by intercepting the bytes). Whether the schema
lacked a return description (adding one, and a `returns` schema: still 0/8).
Whether tool *order* mattered (one run said 0/12 vs 12/12, the next said 3/10 —
noise). Whether the speech guidance suppressed it (8/8 → 0/8 in one run, 6/8 in
another).

The fix was Nick's, and it is one line of the identity prompt:

> You do not know the current date or time. Use a tool to find them.

| | clock called | forecast |
|---|---|---|
| without the line | **0/10** | 10/10 |
| **with the line** | **10/10** | 10/10 |

The forecast tool is unaffected either way, and no tool name leaks into speech.

**Why it is not redundant beside the tool's own description.** The description
says what the tool is for. It does not say the model lacks the information, and
the model does not know that it does not know — it answers confidently and
wrongly. Naming the gap is what triggers the call.

**Phrasing matters more than emphasis.** An earlier emphatic attempt — "you must
call this tool" — made the model speak the tool's name aloud into the answer. A
plain statement of fact behaves better than an instruction shouted louder.

**It is cache-safe.** The line is static text, so the prompt still matches a
cached prefix. The test that guards this was tightened rather than deleted: it
now asserts no date, clock time or weekday *value* appears, instead of banning
the words "date" and "time", which would have blocked this fix for no reason.
