## Next, in order

1. **Active session — built 2026-08-22, needs a kitchen test.** A wake word
   now opens a conversation: after speaking, Barnaby stays listening for
   `follow_up_ms` and VAD alone starts the next turn. The window opens only
   after playback drains, so his own voice cannot trigger it. Sessions end on
   silence, on an empty transcript, or on a tier 0 command; history expires
   separately on `session_idle_ms` (3 min).

   How the four decisions were settled:
   - **Window: 10 s**, chosen deliberately generous. Tested only against fakes.
   - **Tier 0 does not open one** (`follow_up_after_tier0: false`) — device
     commands never reach history, so a follow-up would have nothing to
     resolve against. Moot until a real tier 0 exists.
   - **History expires on time**, not with the window, so re-waking inside a
     session still resolves "what about tomorrow".
   - **Face shows `listening`** while the window is open.

   What is left:
   - **Find the real number for `follow_up_ms`.** 10 s is an open mic with no
     wake word in front of it, in a room with a television, and VAD cannot
     tell a person from a TV. Expect to cut it. Watch for turns nobody started.
   - **Check the empty-transcript exit is right.** A turn the TV opened ends
     the session silently, which is the intent; confirm it does not also eat
     legitimate quiet follow-ups.

2. **Wake word.** Train "barnaby" from synthetic speech — `hey_jarvis` already
   proves the path — then test against the real kitchen, TV on, extractor
   running. Retune `preroll_ms` at the same time; too much of it and the wake
   phrase lands in the transcript.
3. **The Node agent server on the Mac. Phase 1 built 2026-08-22 — needs
   deploying to the Studio and one Pi-side test.** Lives in `agent/`, zero
   runtime dependencies, no build step. Passthrough on :8100, 18 tests green,
   and measured against the real model from a Mac mini at **median TTFT 425 ms,
   40.5 tok/s** with gateway overhead in the noise (-9 ms and +7 ms on two A/B
   runs). Body forwarding is byte-identical, verified against a real
   interception, so `chat_template_kwargs` survives.

   What is left:
   - **Run it on the Studio**, where upstream is loopback rather than a network
     hop — `agent/com.barnaby.agent.plist`, a LaunchAgent not a daemon, because
     phase 2's tools need the logged-in user's files.
   - **Point `llm_url` at :8100** and confirm `--latency` medians on the Pi do
     not move. That is the acceptance gate; a TTFT regression means buffering.
   - **Do not change the model in the same step** — see item 6. Two changes at
     once makes any regression unattributable.

   Original notes, still true:
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
4. **Tool calling.** Tier 1 answers but cannot act. Two things to plan for:
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
5. **Identity, or some way to know who is talking.** No face or voice
   recognition, so personal data stays off limits and the system prompt is the
   only thing enforcing it. Blocks anything personal in tool calling.
6. **The 8-bit model — and it is not the swap it looks like.** There is no
   drop-in 8-bit MTP build: `mlx-community/Qwen3.8-27B-MTP-8bit` is 451 MB, the
   MTP **draft head**, not a servable model. Real 8-bit is 29.5 GB and non-MTP,
   so the upgrade costs **+13.4 GB resident and speculative decoding at the
   same time** — two reasons to expect TTFT to get worse. Do it as the first
   step of *tool calling*, not of the gateway, where it has a real motive and a
   real number to move (tool-call success rate, not latency). Serve it on 8003
   alongside 4-bit rather than replacing it — the gateway already routes, so
   trying it costs no Pi change and reverting is deleting a route.
   `agent/MODEL-NOTES.md` has the sizes and the procedure; `agent/bench.mjs`
   runs the comparison.
7. **TTFT — mostly resolved itself, but find out why.** It was 680 ms and the
   largest stage; on the 2026-08-22 live-mic run it was **357 ms**, with
   Kokoro's first clip also down 603 → 305 ms and total first audio at 1242 ms.
   Nothing was changed to cause that, so the number is not yet trustworthy —
   warm weights on the Mac is the obvious guess. Confirm it holds from cold
   before treating the headroom as real. Still worth confirming `--no-think` is
   actually in effect. 8-bit remains interesting for tool-call reliability
   rather than for latency, and there is now clearly room for it.
8. **Camera + face tracking** when the Wide arrives — emits `look` on the face
   channel, which the renderer already consumes.
9. **ESP32 firmware.**

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