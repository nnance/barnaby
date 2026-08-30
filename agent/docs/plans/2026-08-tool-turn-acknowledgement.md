# Filling the tool gap — streaming tool intent to the robot

Status: **built 2026-08-24.** Step 1's gate was measured and cleared — the
stale ~2500 ms figure was wrong, and the first `tool_calls` delta arrives at a
median of 546 ms. What shipped is Option B, as recommended below.

Still open, and deliberately: the Pi-side policy has been verified against a
real captured stream but **not against a live microphone and speaker**, because
that needs the Pi. `tool_ack_after_ms` (700) is a reasoned starting point, not a
measured one — the thing to listen for is a chirp colliding with the first word,
which means raising it.

## The problem, stated honestly

On a tool turn the user hears nothing until round two starts speaking. Round one
produces no speakable text — it produces a `tool_calls` delta — so the whole of
round one, the tool's own network call, and round two's prefill are silence.

**This is not a TTFT problem and an acknowledgement will not fix TTFT.** The
answer arrives when it arrives. What is wrong is that the silence is
*unexplained*: it looks identical to a hang, and the user starts repeating
themselves into it. So the thing to improve is perceived latency, and the
measure of success is "there is audio inside the gap", not "`tool_gap_ms` went
down". Anything claiming to have improved TTFT here is measuring wrong.

Keeping these separate matters, because the two goals want opposite things:
genuinely cutting the gap means attacking round-two prefill, and that is a
different piece of work (noted at the end, deliberately not this plan).

## What is already true, and must not be broken

- `tool_gap_ms` is **~500 ms** since the alias fix, down from ~1300 ms. The
  numbers still quoted in `agent/src/agent.ts` comments (1031-1350 ms, and the
  ~2500 ms median for the first `tool_calls` delta) are from **before** that fix
  and should be treated as stale until re-measured. See step 1.
- A turn using **no** tool must stay byte-identical and exactly as fast. This is
  the constraint the current buffering logic bends over backwards to keep, and
  it is the one worth keeping most: the common case must not pay for the rare one.
- The Pi sees **one** SSE stream ending in **one** `[DONE]`. Everything below
  either preserves that or changes it deliberately and says so.
- Round-one content is currently **held** and often **dropped** — the model's own
  "let me check the forecast for you" is suppressed on purpose, because measured
  it arrived after the silence it was meant to cover and then delayed the answer.

## The decision this plan actually turns on

Two options were named in the request. They are not alternatives at the same
level — one is a superset of the other.

**Option A — the agent speaks the ack.** The gateway emits a synthetic content
frame ("Let me check.") the instant the first `tool_calls` delta arrives. The Pi
needs no change: it is an ordinary content delta, it goes through
`stream_sentences`, TTS synthesises it, the speaker plays it.

**Option B — the agent streams the tool intent; the robot decides.** The gateway
emits a frame describing *what is happening* — tool name, and that a call has
started — and the Pi chooses the response: a chirp, a face change, a spoken
line, or nothing.

**Recommendation: build B, and make A a special case of it.** The reason is not
flexibility for its own sake. It is that the right response to "a tool is
running" is **almost certainly not speech**:

- Barnaby already has a non-verbal acknowledgement vocabulary that costs zero
  latency and no network — `chirp()` and the face. Tier 0 already uses exactly
  this reasoning: "acknowledge, don't narrate. A chirp beats four seconds of TTS
  explaining what you already watched happen."
- A spoken ack costs a **TTS round trip** (~286 ms measured for the first Kokoro
  clip) inside a ~500 ms gap. It may not fit. A chirp or a face change is
  instant.
- The ack then has to *finish playing* before the answer starts, or the two
  overlap. At ~500 ms of gap and a spoken ack of a second or more, the ack
  becomes the thing delaying the answer — which is precisely the failure already
  documented for the model's own narration, rebuilt deliberately.

So: send the fact, let the Pi pick the reaction, and let the default reaction be
the cheap one. If a spoken ack turns out to be wanted, the Pi can synthesise it
from the tool name locally, and it is still one policy change on one machine.

This also matches the existing split the repo already commits to: the agent owns
what is true, the client owns presentation. "A weather tool is running" is a
fact. "Say 'let me check'" is presentation, and the agent cannot know whether
its caller has a speaker.

## Step 1 — measure before designing (blocking, and cheap)

Nothing below is worth building against stale numbers. Three things to establish,
against the live model on the alias:

1. **When does the first `tool_calls` delta arrive?** Measured from `llm_sent`.
   The code comment says ~2500 ms and uses it to argue an ack is pointless. If
   that is now ~200-400 ms, the argument inverts and an ack lands early enough to
   be worth having. If it really is still ~2500 ms, **stop** — an ack cannot help,
   and the work to do instead is round-two prefill.
2. **What is `tool_gap_ms` now**, over ~12 turns, median and spread. Four turns is
   not a sample; that lesson is already written down in CLAUDE.md.
3. **How long is the gap in user terms** — first tool dispatch to first *audio*,
   not first token. This is the number the ack is competing against.

Add a `tool_dispatch` mark so this is recorded rather than observed. One log line
per tool turn: time to first `tool_calls` delta, tool duration, round-two TTFT.

**Gate:** if the first `tool_calls` delta lands later than ~600 ms into a ~500 ms
gap, an acknowledgement is structurally too late and this plan is the wrong work.
Say so and stop.

## Step 2 — the wire format

A new SSE frame the Pi can recognise and any other client can ignore. It must be
ignorable: a web chat calling this agent should not break, and the passthrough
guarantee means malformed frames are already tolerated.

```
data: {"object":"barnaby.tool_call","tool":"weather","phase":"started"}
```

Design notes, each with a reason:

- **`object` is a new value, not a `choices[0].delta`.** The Pi's parser reads
  `choices[0].delta.content` and skips anything else, so an unknown object type
  is ignored by existing code and by any OpenAI-compatible client. Smuggling it
  into a content delta would make every client speak it aloud, which is Option A
  with no opt-out.
- **`phase`**, not just a name: `started` when the call is dispatched, and
  `finished` when results are in and round two begins. The second one matters —
  it lets the Pi stop a "thinking" animation, and it bounds the gap so a stuck
  tool is visible rather than mute.
- **The tool name is sent, the arguments are not.** The Pi has no use for them,
  and coordinates from CONTEXT.md are exactly the personal data the repo already
  keeps out of places it does not need to be.
- **No new endpoint, no session id.** Statelessness stays.

The `[DONE]` contract is unchanged, and these frames are emitted through the same
`emit` the content frames use, so backpressure and abort handling are inherited
rather than duplicated.

## Step 3 — the agent side

In `runTurn`, at the point where `accumulator.add(delta.tool_calls)` already
runs — the code comment there already argues for exactly this and then declines
to do it on the strength of the stale 2500 ms figure.

- Emit `phase:"started"` **once per turn**, on the first `tool_calls` delta, as
  soon as a tool *name* is known (the name arrives before the arguments finish
  streaming, which is the whole reason this can be early). Not once per call: two
  tools in one round is one acknowledgement.
- Emit `phase:"finished"` after the tool results are appended, before round two's
  upstream call.
- **Do not touch the hold-and-drop logic.** The model's own narration stays
  suppressed. Replacing a suppressed spoken promise with an unsuppressed spoken
  ack would reintroduce the documented failure with extra steps.
- Count these bytes separately in the result, so `bytes` stays a measure of
  answer content and the log stays comparable to phase 1.

Tests, mirroring the ones that already exist and matter:
- A tool turn emits exactly one `started` and one `finished`.
- **A tool-less turn emits neither, and its stream is byte-identical to today's.**
  This is the load-bearing test, the same way `streams incrementally` is.
- A client that ignores unknown objects still gets a well-formed stream ending in
  one `[DONE]`.
- Frames survive being split across chunk boundaries (the parser already handles
  this; the test is that the emitter does not assume otherwise).

## Step 4 — the Pi side

`stream_sentences` currently yields `(sentence, is_first)`. It needs to surface a
second kind of event without every caller learning about tools.

Recommended shape: an `on_tool` callback, matching the existing `on_first_token`
callback rather than changing the yield type. Callers that do not pass it are
unaffected, and `_answer` is the only caller that will.

Default policy in `_answer`, and it should be the cheap one:

- On `started`: face to `curious` (it already goes there on thinking — this makes
  it *mean* something), and **a chirp only if the gap exceeds a threshold**. The
  threshold matters: at 500 ms nothing should be emitted at all, because a chirp
  and then an answer 300 ms later is noise. Fire the chirp on a timer armed by
  `started` and cancelled by the first content token, so the ack appears **only on
  turns that are actually slow.** This is the single most important detail in the
  plan — an unconditional ack makes fast turns worse.
- On `finished`: cancel the timer, face back to whatever thinking looks like.
- Config: `tool_ack_after_ms` (suggest 700, i.e. only fire when we are already
  past the budget), and `tool_ack` as `chirp` / `speak` / `none`. Default `chirp`.

Metrics: a `tool_started` mark, so `--latency` reports the gap rather than hiding
it inside `llm_sent -> first_token`. Without this the latency table reports a
tool turn as one enormous TTFT and the ack's effect is invisible.

## Step 5 — verify

- `--latency` over ~12 tool turns and ~12 plain turns. **Plain-turn medians must
  not move.** That is the gate, same as phase 1's.
- Listen to it. A tool turn should sound like acknowledgement then answer, not
  like an interruption. If the chirp regularly collides with the first word, the
  threshold is too low.
- Confirm a plain `curl` client still sees a clean stream.

## What this deliberately does not do

- **It does not cut the gap.** The real fix is round-two prefill — the tool call
  itself is the smallest part of the wait, and the archived phase 2 notes already
  identify prefill as the target. An ack makes the wait explicable; it does not
  make it shorter. Worth doing after this, and worth not confusing with it.
- **It does not make the model narrate.** Round-one content stays held and
  dropped.
- **It does not add a session id or any state.** Stateless, still curl-able.
