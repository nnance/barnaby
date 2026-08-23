# `agent/` — the Node agent server

Sits between the Pi and rapid-mlx on the Mac Studio. Phase 1 is a passthrough
and its whole job is to be invisible. Tool calling lands here in phase 2.

See `PLAN.md` for why it exists and what phase 2 looks like.

## Rolling back, first, because you will want it

This server is on the LLM leg only. ASR and TTS talk to rapid-mlx directly and
are unaffected, so a broken agent server can never cost you the microphone.

To revert, put `llm_url` back and restart the Pi:

```yaml
# orchestrator/config.yaml
llm_url: http://nicks-mac-studio.local:8001/v1   # was :8100/v1
```

You will restart this thing constantly while developing, and "Barnaby went
mute" gets old.

## Running it

Needs Node 23+ for native TypeScript type stripping — there is **no build
step**. Node 24.10 is what this was written against.

```bash
pnpm install     # dev dependencies only; nothing ships at runtime
pnpm start       # or: pnpm dev, which restarts on change
```

Then point the Pi at it:

```yaml
# orchestrator/config.yaml
llm_url: http://nicks-mac-studio.local:8100/v1
```

`asr_url` and `tts_url` stay on 8000 and 8002. Only the LLM leg moves.

## Configuration

All optional. The defaults assume this server and rapid-mlx on the same Mac.

| Variable | Default | Notes |
|---|---|---|
| `BARNABY_AGENT_PORT` | `8100` | Clear of the 8000-8002 rapid-mlx block |
| `BARNABY_AGENT_HOST` | `0.0.0.0` | The Pi is a different machine — the same trap rapid-mlx has |
| `BARNABY_UPSTREAM_URL` | `http://127.0.0.1:8001/v1` | Set this when developing off-Studio |
| `BARNABY_UPSTREAM_TIMEOUT_MS` | `55000` | Under the Pi's 60 s, so we fail first and say why |
| `BARNABY_CONTEXT` | `agent/CONTEXT.md` | Personal context — see below. Missing is fine; he just knows nothing about the household |
| `BARNABY_MODEL` | *(caller's)* | **The agent picks the model, not the Pi.** Tools only work with a model that calls them reliably, so the tool layer and the model choice are one decision. Unset passes the caller's model through, which is phase 1 behaviour |
| `BARNABY_LATITUDE` / `BARNABY_LONGITUDE` | *(none)* | Where "the weather" means. Both must be set or the tool is not offered at all and the gateway is a plain passthrough |
| `BARNABY_PLACE` | `home` | Named only so an answer can say where it is talking about |

## Personal context, and where the system prompt lives

**The Pi does not have a system prompt.** It is a client of an agent, not a
caller of an LLM: it sends what was said and plays what comes back. Who Barnaby
is, which model answers, what tools exist, and what he knows about the household
are all decisions of the intelligence layer, and that is this server. The Pi
still sends a system message today; it is dropped, so the Pi keeps working
untouched while what it sends stops mattering.

Personal details live in **`agent/CONTEXT.md`, which is gitignored and must stay
that way** — names and a home location to within a few hundred metres have no
business in a public repo. `CONTEXT.example.md` is the committed template.

```markdown
---
latitude: 35.22257
longitude: -97.43948
place: Norman
units: fahrenheit
---

You live in the kitchen of Nick and Rhonda's home in Norman, Oklahoma.
```

The prose is appended to the system prompt. The frontmatter is for tools that
need numbers: a model reading a town name out of a paragraph and guessing
coordinates is wrong in a way nobody notices until the forecast is for another
town. Env vars still override it, so a deployment can point somewhere else
without editing the file.

Keep the prose short — every word is sent on every turn.

## Routes

| Route | Who calls it |
|---|---|
| `POST /v1/chat/completions` | The Pi, every turn. Streams SSE |
| `GET /v1/models` | `python -m barnaby --check`. Proxied, not faked — a made-up list would make `--check` pass with the model missing |
| `GET /healthz` | You. Upstream reachability and uptime |

## Checking it

```bash
pnpm check    # tsc --noEmit; the runtime strips types without checking them
pnpm test     # 14 tests against a fake rapid-mlx
pnpm lint
```

The load-bearing test is **`streams incrementally`**. Every other test in the
file would still pass on a gateway that buffered the whole answer and flushed
it at the end — and that gateway would quietly destroy time-to-first-audio
while looking perfectly correct.

By hand, against the real thing:

```bash
curl -sN http://localhost:8100/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.8-27b-4bit","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Watch it, do not just capture it. Frames must appear one at a time. If the
whole answer lands at once, something is buffering and TTFT is gone.

## What breaks silently

1. **Buffering.** Sentence-pipelined TTS depends on token-level SSE arriving as
   tokens. Any compression or buffering middleware turns time-to-first-audio
   into full-response latency, and the answer is still correct — just late. The
   response sets `no-transform`, `identity` and `x-accel-buffering: no`, and
   never introduces middleware. Do not add compression to this server.
2. **Dropping `chat_template_kwargs`.** The request body is forwarded as bytes
   and never re-serialised, so `enable_thinking: false` survives and
   `--no-think` holds. Verified byte-for-byte in the tests.
3. **Swallowing `[DONE]`.** The Pi's read loop breaks on it; without it the
   turn hangs to the 60 s timeout. Phase 1 never parses the stream, so it
   cannot lose it.

## Log lines

One per request. `ttft` is measured here at the gateway, which makes it the
buffering canary: if this says 350 ms and the Pi's `--latency` says 900 ms, the
delay is between the gateway and the Pi, not in the model.

```
19:50:53.139 chat 200 msgs=3 stream=true ttft=421ms total=1233ms bytes=8214
```

## Gotchas found the hard way

| Thing | Detail |
|---|---|
| Abort must listen on `res`, not `req` | `req` emits `close` as soon as the request body is read — *before* the first token. Hooking it there fires on every healthy turn and never on a real disconnect, so upstream keeps generating into a dead socket. `res` closes only when the socket actually goes away |
| `127.0.0.1` is wrong off-Studio | The default assumes this runs on the Studio beside rapid-mlx. Developing on another Mac, set `BARNABY_UPSTREAM_URL` or every request 502s with `ECONNREFUSED` while `curl` to the hostname works fine |
| rapid-mlx sends `: keepalive` comment frames | Not `data:` lines. The Pi's `startswith("data: ")` filter ignores them correctly; anything that parses this stream in phase 2 must too |
| No `enum`, `namespace`, or constructor parameter properties | Node strips types rather than compiling them, so anything that *emits* code is rejected at runtime — and **`tsc --noEmit` does not catch it**. `readonly status: number` as a constructor parameter looks fine to `tsc` and dies under `node`. Write plain fields and assign in the body. `pnpm test` is the check that matters. See "On `tsx`" below — this is a live trade, not a permanent rule |
| Errors are not streamed | A failure returns a non-streaming JSON 4xx/5xx on purpose. `httpx.raise_for_status()` turns that into a clean fault; an empty 200 stream looks like a model with nothing to say |


## On `tsx` — not now, but not a hard no

`tsx` would lift the strip-only restriction above: it transpiles rather than
strips, so `enum`, `namespace`, decorators and constructor parameter properties
all work. It is a **devDependency and a transpile step, not a runtime
dependency** — the deployed process would still be Node running the result.

It is not in yet only because the friction so far does not justify the change.
One class, once, cost three extra lines. That is a thin reason to add a build
step to the thing that stands between the Pi and its model.

**Reasons to revisit, any of which is enough:**

- Two or three more real collisions with strip-only, especially in the tool
  layer as it grows. One is a curiosity; several is a tax.
- Wanting decorators, most likely for tool registration — declaring a tool by
  annotating a class is genuinely nicer than the current registry function.
- A dependency that ships types requiring transpilation.
- The runtime constraint biting somewhere `pnpm test` does not reach, since
  `tsc --noEmit` is blind to it.

**What to weigh against it:** today `node src/main.ts` *is* the deployment, and
there is no transform between the source you read and the bytes that run. That
is worth keeping while it is free. It stops being free the moment the code
starts contorting to avoid the restriction — at which point take `tsx`.
