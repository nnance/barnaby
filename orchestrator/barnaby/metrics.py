"""Per-turn latency instrumentation.

Streaming is only worth the complexity if you can prove it helped, so every
stage stamps itself and every turn prints a table. The numbers that matter:

  wake -> endpoint      how long the user talked (not our problem)
  endpoint -> asr_done  Whisper on the Mac
  asr_done -> tier0     Home Assistant Assist round trip
  asr_done -> first_tok LLM time to first token
  first_tok -> speaking FIRST AUDIO OUT — this is the number a human feels
  endpoint -> speaking  total perceived latency

Targets, from the design doc: device command under 700 ms end to end,
spoken answer under 2000 ms to first audio.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("barnaby.metrics")

# Where each turn is appended as one JSON object. Printed metrics scroll away
# with the terminal, which made every latency claim so far a matter of whoever
# happened to be looking at the screen — and two stages once moved by 300 ms
# with no record of when. One line per turn, so `tail`, `grep` and jq all work
# without a parser.
LOG_PATH = Path.home() / ".cache" / "barnaby" / "turns.jsonl"

# Stages in the order they should appear in the report.
# In a streaming pipeline SPEAKING happens BEFORE tts_done — audio starts on
# sentence one while later sentences are still being synthesised. Listing
# tts_done first produced a negative delta and a meaningless report.
# `tts_done` is when *synthesis* finished, not when Barnaby stopped talking —
# audio is still playing long after it. Without `playback_done` the table ends
# at ~400 ms for a turn where he speaks for twelve seconds, which hid exactly
# that: a follow-up window that opens only once he finishes is useless if
# nothing reports how long finishing takes.
# `tool_started` and `tool_done` bracket the agent's tool call, and they sit
# between llm_sent and first_token because that is exactly where the silence
# is: on a tool turn the first token is round TWO's. Without these the table
# reports a tool turn as one enormous TTFT and cannot say whether the wait was
# the model deciding, the tool running, or round two prefilling.
# `tool_ack` is when we made a noise about it, and is absent on turns fast
# enough that we never needed to.
ORDER = [
    "wake", "endpoint", "asr_sent", "asr_done", "tier0_done",
    "llm_sent", "tool_started", "tool_ack", "tool_done",
    "first_token", "first_sentence", "speaking", "tts_done",
    "playback_done", "done",
]


@dataclass
class Turn:
    """One wake-to-silence interaction."""

    marks: dict[str, float] = field(default_factory=dict)
    text: str = ""
    reply: str = ""
    tier: str = "-"
    t0: float = field(default_factory=time.perf_counter)

    def mark(self, name: str) -> None:
        self.marks.setdefault(name, time.perf_counter())

    def since(self, a: str, b: str) -> float | None:
        if a in self.marks and b in self.marks:
            return (self.marks[b] - self.marks[a]) * 1000
        return None

    @property
    def perceived(self) -> tuple[str, float] | None:
        """Time to first audio, and what it was measured from.

        Normally endpoint-to-audio — the only latency a human feels. With
        --say there is no microphone and therefore no endpoint, so we fall back
        to the LLM request and label it honestly rather than reporting -1.
        """
        for start, label in (("endpoint", "endpoint -> audio"),
                             ("asr_sent", "asr -> audio"),
                             ("llm_sent", "llm -> audio")):
            ms = self.since(start, "speaking")
            if ms is not None:
                return label, ms
        return None

    def record(self, targets: dict[str, int], path: Path | None = None) -> None:
        """Append this turn to the JSONL log.

        Deltas are stored alongside the raw marks. The marks are the source of
        truth — they are `perf_counter` values, so only meaningful relative to
        each other within a turn — but storing the deltas too means a question
        like "what has TTFT done this week" is a one-liner rather than a
        subtraction against ORDER.

        Never raises. A full disk or a read-only home is not a reason to drop
        the conversation the user is currently having.
        """
        path = path or LOG_PATH
        deltas = {}
        prev: str | None = None
        for name in ORDER:
            if name not in self.marks:
                continue
            if prev is not None:
                dt = self.since(prev, name)
                if dt is not None:
                    deltas[f"{prev}->{name}"] = round(dt, 1)
            prev = name

        got = self.perceived
        row = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "tier": self.tier,
            "text": self.text,
            "reply": self.reply,
            # Which mark first audio was measured from. With --say there is no
            # endpoint, so a run's numbers are not comparable to a live one's
            # unless you know this — hence storing it rather than the ms alone.
            "measured_from": got[0] if got else None,
            "first_audio_ms": round(got[1], 1) if got else None,
            "budget_ms": targets.get(
                "device_command_ms" if self.tier == "tier0"
                else "spoken_answer_ms"),
            "deltas_ms": deltas,
            "marks": {k: round(v - self.t0, 4) for k, v in self.marks.items()},
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as fh:
                fh.write(json.dumps(row) + "\n")
        except Exception:                              # noqa: BLE001
            log.debug("could not write %s", path, exc_info=True)

    def report(self, targets: dict[str, int], record: bool = True) -> None:
        rows: list[tuple[str, float]] = []
        prev: str | None = None
        for name in ORDER:
            if name not in self.marks:
                continue
            if prev is not None:
                dt = self.since(prev, name)
                if dt is not None:
                    rows.append((f"{prev} -> {name}", dt))
            prev = name

        width = max((len(r[0]) for r in rows), default=20)
        lines = [f"  {a:<{width}}  {ms:7.1f} ms" for a, ms in rows]

        if record:
            self.record(targets)

        budget = targets["device_command_ms"] if self.tier == "tier0" \
            else targets["spoken_answer_ms"]
        got = self.perceived
        if got is None:
            log.info("turn [%s] %r — no audio produced\n%s",
                     self.tier, self.text, "\n".join(lines))
            return

        label, ms = got
        partial = not label.startswith("endpoint")
        verdict = "OK" if ms <= budget else f"OVER by {ms - budget:.0f} ms"
        if partial:
            verdict += "  (partial — no mic in this run)"

        log.info(
            "turn [%s] %r\n%s\n  %-*s  %7.1f ms   budget %d  %s",
            self.tier, self.text, "\n".join(lines), width,
            f"TIME TO FIRST AUDIO ({label})", ms, budget, verdict,
        )