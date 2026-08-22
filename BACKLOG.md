## Next, in order

1. **ReSpeaker — enumerating, now validate it against a human.** It came back
   on 2026-08-22 with nothing changed (`2886:001a`, card 3), and `config.yaml`
   now points `input_device` at it. Capture works through the pipeline's own
   path; the descriptor says 2 channels, beamformed on-board, no raw capsules.

   What is **not** done, because it needs someone talking to it:
   - **Far-field transcription.** Every test so far recorded an empty room, and
     Whisper hallucinated confidently into the silence. Speak at counter
     distance, off-axis, and confirm the transcript.
   - **Gain.** Capture is at max (0 dB) and ambience alone peaks near −1 dBFS.
     Almost certainly wants turning down; `--levels` while speaking is the
     check, then `amixer -c 3 sset Headset,0 Capture <n>`.
   - **Wake-word range** at the same distances, now that beamforming is back.
   - **Barge-in stays off** until the JST pigtail moves playback to the array —
     AEC has no reference signal until then, so this cannot be tested yet.
2. **Active session — the wake word should open a conversation, not a turn.**
   Say "Barnaby, what's the weather", then just say "what about tomorrow"
   without waking him again. Today every single turn needs the wake word, which
   makes talking to him feel like issuing commands rather than having a
   conversation.

   The context half is already built: `_answer` feeds `history[-6:]` back to
   the LLM, so follow-ups already resolve correctly once they reach it. The
   missing half is the listening window — after Barnaby stops speaking, stay
   open for a few seconds and let VAD alone start the next turn, the way
   `--open-mic` does but time-boxed. Safe to build before the array arrives,
   because the window opens *after* playback ends and so needs no AEC.

   Four decisions:
   - **How long the window stays open.** It inherits `--open-mic`'s weakness —
     an open mic in a kitchen will sometimes answer the television. Short
     enough that this is rare, long enough to be worth having.
   - **Whether tier 0 opens one.** Device commands return before `_answer` and
     never touch history, so "turn off the kitchen lights" then "and the
     counter ones too" has nothing to work with. Arguably the bigger gap.
   - **When the session ends.** History never expires today — it is a plain
     list living as long as the process, so this morning's conversation is
     still in context tonight. `sleep_after_frames` (~3 min idle) is the
     natural place to clear it.
   - **What the face shows** while the window is open, so it is visible that he
     is still listening. `listening` already exists.
3. **Wake word.** Train "barnaby" from synthetic speech — `hey_jarvis` already
   proves the path — then test against the real kitchen, TV on, extractor
   running. Retune `preroll_ms` at the same time; too much of it and the wake
   phrase lands in the transcript.
4. **The Node agent server on the Mac.** Stand it up as a pure passthrough
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
5. **Tool calling.** Tier 1 answers but cannot act. Two things to plan for:
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
6. **A systemd unit for the Pi.** Nothing starts on boot today; it is
   `cd ~/barnaby && source .venv/bin/activate && python -m barnaby` by hand
   every time. Put the token in an `EnvironmentFile` rather than a shell
   `export` that does not survive.
7. **Attack the 680 ms TTFT.** Confirm `--no-think`. Consider 8-bit for better
   tool-call reliability; there's headroom.
8. **Camera + face tracking** when the Wide arrives — emits `look` on the face
   channel, which the renderer already consumes.
9. **ESP32 firmware.**

**Deferred to a later conversation: all CAD.** The parametric model in
build123d is blocked on measuring the HDMI control board, its FPC length, and
camera depth — those decide whether the board lives in the head or the body,
which sets the column diameter and therefore the tilt cone.