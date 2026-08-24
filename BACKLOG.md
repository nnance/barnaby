## Next, in order

1. **Wake word.** Train "barnaby" from synthetic speech — `hey_jarvis` already
   proves the path — then test against the real kitchen, TV on, extractor
   running. Retune `preroll_ms` at the same time; too much of it and the wake
   phrase lands in the transcript.
2. **The Node agent server on the Mac. Phase 1 built 2026-08-22 — needs
   deploying to the Studio and one Pi-side test.** Lives in `agent/`, zero
   runtime dependencies, no build step. Passthrough on :8100, 18 tests green.
   Body forwarding is byte-identical, verified against a real interception, so
   `chat_template_kwargs` survives.

   Measured from a **Mac mini**, so including a network hop the real
   deployment will not have: median TTFT 425 ms at 40.5 tok/s, gateway
   overhead in the noise (-9 ms and +7 ms on two A/B runs against direct
   rapid-mlx). Not comparable to the Pi's 640 ms median in item 5 — different
   machine, different path, no wake word or VAD in front of it.

   What is left:
   - **Run it on the Studio**, where upstream is loopback rather than a network
     hop — `agent/com.barnaby.agent.plist`, a LaunchAgent not a daemon, because
     phase 2's tools need the logged-in user's files.
   - **Point `llm_url` at :8100** and confirm `--latency` medians on the Pi do
     not move. That is the acceptance gate; a TTFT regression means buffering.
     Compare against the recorded spread, not a single turn — item 5 is exactly
     the trap of reading one fast turn as a change.
   - **Do not change the model in the same step** — see item 5. Two changes at
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
   confirming `--no-think` is actually in effect — though note the server
   reports `reasoning_parser: null` and `default_reasoning_level: "none"`, so
   thinking may already be off independently of the flag.

   **8-bit is not the swap it looks like, and the thin headroom makes that
   worse.** There is no drop-in 8-bit MTP build: today's model is
   `Qwen3.8-27B-4bit-MTP-MLX` and `mlx-community/Qwen3.8-27B-MTP-8bit` is
   451 MB — the MTP **draft head**, not a servable model. Real 8-bit is 29.5 GB
   and non-MTP, so the upgrade costs **+13.4 GB resident and speculative
   decoding at the same time**, two reasons to expect TTFT to get *worse*. With
   total first audio at 1608 ms against a 2000 ms budget there is not much to
   give away.

   So do it for tool-call reliability, as the first step of item 3, where it
   has a real number to move — and serve it on 8003 **alongside** 4-bit rather
   than replacing it. The gateway is already the routing seam, so trying it
   costs no Pi change and reverting is deleting a route.
   **Done 2026-08-23, and not the way this describes.** The model is now
   `qwen3.6-35b-8bit`, a mixture-of-experts that is 8-bit *and* faster than the
   4-bit dense model it replaced — so the trade-off agonised over above was
   never the one on offer. Tool decisions went 2287 → 530 ms, ordinary TTFT
   424 → 171 ms, throughput 37.8 → 82.2 tok/s. The bigger lesson was unrelated
   to precision: serve by rapid-mlx **alias**, never by HuggingFace path, or the
   prefix cache never engages. `pnpm bench` in `agent/` still runs the comparison.
6. **Camera + face tracking** when the Wide arrives — emits `look` on the face
   channel, which the renderer already consumes.
7. **ESP32 firmware.**

**Two small things needing a password, so left for Nick.**

- **Make the journal persist.** `/var/log/journal` does not exist, so
  `Storage=auto` keeps logs in `/run` and a reboot loses them. Today's VAD bug
  was found by reading the journal; losing it on reboot is worse than it
  sounds. `sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create
  --prefix /var/log/journal`
- **`HA_TOKEN` in `~/barnaby/barnaby.env`** whenever HA exists. The unit
  already reads it via `EnvironmentFile`; unset, it silently disables tier 0.

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