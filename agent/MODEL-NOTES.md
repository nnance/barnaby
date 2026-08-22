# Upgrading the LLM from 4-bit

Backlog item 6 wants 8-bit for **tool-call reliability**, not latency — which
makes it a phase 2 question, since phase 2 is tool calling. What follows is
what the options actually are, measured rather than assumed.

## What is being served today

`rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX` — 16.1 GB, 3 shards. Note **MTP**:
multi-token prediction, a speculative-decoding variant. That is not incidental
to the good TTFT numbers, and it is the thing a naive upgrade would throw away.

The server also advertises what phase 2 needs:

```
capabilities: ["text", "tools"]      tool_call_parser: "hermes"
context_window: 262144               reasoning_parser: null
```

`reasoning_parser: null` and `default_reasoning_level: "none"` mean thinking is
already off at the server, independent of `--no-think`. Worth knowing: it means
a `chat_template_kwargs` regression would **not** show up as `<think>` tags in
the output. The gateway's byte-identical forwarding test is the only thing
actually guarding that, which is why it asserts on bytes and not on behaviour.

## The 4-bit baseline, measured

Through the gateway, five kitchen-shaped questions, warmup discarded
(`node bench.mjs`):

```
MEDIAN ttft=472ms   tok/s=40.5   markdown leaked into speech: 0/5
```

Measured from a Mac mini, so this **includes a network hop to the Studio** that
the real deployment does not have. Treat 472 ms as a ceiling, not the number.

## The trap: there is no drop-in 8-bit MTP

`mlx-community/Qwen3.8-27B-MTP-8bit` looks like the obvious answer and is not a
servable model. It is **451 MB in a single shard** — the MTP draft head alone,
meant to pair with a base model, not replace one.

The real 8-bit builds are non-MTP:

| Model | Weights | MTP |
|---|---|---|
| `rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX` (current) | 16.1 GB | yes |
| `mlx-community/Qwen3.8-27B-8bit` | 29.5 GB | no |
| `lmstudio-community/Qwen3.8-27B-MLX-8bit` | 29.5 GB | no |

So the upgrade costs **+13.4 GB of resident memory and the loss of speculative
decoding at the same time**. Two separate reasons to expect TTFT and tok/s to
get worse, on a machine that also runs Whisper, Kokoro, and other household
workloads in 96 GB.

## Recommendation

**Do not swap it as part of phase 1.** Phase 1's whole claim is that the
gateway is invisible, and its acceptance gate is that `--latency` medians do
not move. Changing the model in the same step destroys the only measurement
that proves the gateway works — any regression becomes unattributable between
two changes.

Do it as the **first step of phase 2**, where it has a real motive (tool-call
reliability) and something to measure against (tool-call success rate, not
TTFT). The order that keeps every result attributable:

1. Land phase 1. Confirm `--latency` is unchanged on the Pi.
2. Build tool calling on 4-bit. Get a tool-call success rate — that is the
   number 8-bit is supposed to improve, and without it there is nothing to
   justify 29.5 GB.
3. Serve 8-bit on a **second port** (8003) alongside 4-bit rather than
   replacing it. Both stay up; the gateway is already the natural place to
   route per-turn between them, which the plan calls out.
4. Re-run `bench.mjs` against both, plus the tool-call suite. Decide on
   evidence.

Step 3 is the reason to do this behind the gateway at all: the routing seam
already exists, so trying 8-bit costs no Pi change and no downtime, and
reverting is deleting a route.

## Running the comparison, when you get there

On the Studio:

```bash
rapid-mlx serve mlx-community/Qwen3.8-27B-8bit --port 8003 --host 0.0.0.0 --no-think
```

Then, from anywhere:

```bash
node bench.mjs http://nicks-mac-studio.local:8003/v1/chat/completions mlx-community/Qwen3.8-27B-8bit
node bench.mjs   # the 4-bit baseline, through the gateway
```

Watch memory on the Studio while both are loaded — 16.1 + 29.5 GB of weights
plus Whisper and Kokoro is the case where the M.2/servo power story is not the
only thing under pressure.
