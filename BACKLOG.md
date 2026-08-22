## Next, in order

1. **Wake word.** Train "barnaby" from synthetic speech — `hey_jarvis` already
   proves the path — then test against the real kitchen, TV on, extractor
   running. Retune `preroll_ms` at the same time; too much of it and the wake
   phrase lands in the transcript.
2. **The Node agent server on the Mac.** Stand it up as a pure passthrough
   first, on its own port, so the Pi change is one line — point `llm_url` at it
   and leave ASR and TTS talking to rapid-mlx directly, off the critical path.
   Get that boring before adding anything.
   - **Streaming is the thing that will silently break.** Sentence-pipelined
     TTS depends on token-level SSE — `delta.content` chunks then `[DONE]`. Any
     buffering middleware (compression especially) turns time-to-first-audio
     into full-response latency and nothing looks broken. Forward
     `chat_template_kwargs.enable_thinking` too or `--no-think` is lost.
   - **Keep it stateless first.** The Pi keeps sending the message array; add a
     session id later. A stateless endpoint can be debugged with `curl`.
   - **Keep a direct-to-rapid-mlx fallback** — not for reliability (if the Mac
     is up, both are up) but because you will restart the agent server
     constantly while developing and "Barnaby went mute" gets old.
   - It is also the natural place to route per-turn between the local model and
     a frontier one, which may be what makes tool calling work at all. Privacy
     cost, chosen deliberately.
3. **Tool calling.** Tier 1 answers but cannot act. Two things to plan for:
   - **It breaks the 2 s budget inherently.** A tool turn is two inference
     rounds before the first speakable token — ~1.4 s before the tool even
     runs. Decide what he does in the gap; the face already goes `curious`, but
     a spoken acknowledgement may be wanted. The latency table needs new stage
     marks per tool round or it will report nonsense.
   - **The mic is now an attack surface.** Today a wake-word false positive
     costs a wasted LLM call; once tools read mail and files, anything the
     television says can reach real data, and mail flowing into the model is
     prompt injection aimed at your tools. Read-only tools first, an explicit
     allowlist rather than an open plugin surface, confirmation for side
     effects. Benchmark reliability too — small models are weak at multi-step
     tool use.
4. **Identity, or some way to know who is talking.** No face or voice
   recognition, so personal data stays off limits and the system prompt is the
   only thing enforcing it. Blocks anything personal in tool calling.
5. **TTFT, the largest stage we control.** Median 640 ms over 12 recorded
   turns, spread 345-760. An earlier single turn read 357 ms and was briefly
   believed to be an improvement; it was just the fast end of the spread, so
   there is nothing to explain and nothing has regressed. Still worth
   confirming `--no-think` is actually in effect. 8-bit is interesting for
   tool-call reliability rather than latency — total first audio is 1608 ms
   against a 2000 ms budget, so the headroom is thinner than it looked.
6. **Camera + face tracking** when the Wide arrives — emits `look` on the face
   channel, which the renderer already consumes.
7. **ESP32 firmware.**

**Working, but only tested in a quiet room — the active session.** A wake word
opens a conversation and a follow-up needs no second wake word (confirmed
2026-08-22, including a pronoun resolved against history). Two things to watch
now that it is in daily use:

- **`follow_up_ms` is 10 s and the TV has not been tried against it.** Inside
  the window there is no wake word, only VAD, which cannot tell a person from
  a television. Cut it if turns start appearing that nobody began.
- **The wait before the window opens is the answer length**, since it opens
  only once playback drains. A 10 s answer means 10 s before a follow-up is
  possible. `max_tokens` is 400 by choice; that is the cost.

**Not blocking anything, so unnumbered — acoustic characterisation.** The array
is confirmed working end to end (2026-08-22), including with music playing, and
nothing about it currently needs tuning. What was never measured, worth doing
only when something misbehaves or before trusting the wake word in anger:
usable range and off-axis angle; behaviour with the extractor running; and
capture gain, which sits at max (0 dB) and is fine as shipped. Barge-in cannot
be tested at all until playback moves to the array.

Related, and done 2026-08-22: **per-turn metrics now persist** to
`~/.cache/barnaby/turns.jsonl`, one JSON object per turn, with
`python -m barnaby --latency` for a median/min/max summary per stage. Latency
claims are now checkable rather than a matter of who was watching the terminal.

**Deferred to a later conversation: all CAD.** The parametric model in
build123d is blocked on measuring the HDMI control board, its FPC length, and
camera depth — those decide whether the board lives in the head or the body,
which sets the column diameter and therefore the tilt cone.