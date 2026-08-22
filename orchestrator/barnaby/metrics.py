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

import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger("barnaby.metrics")

# Stages in the order they should appear in the report.
# In a streaming pipeline SPEAKING happens BEFORE tts_done — audio starts on
# sentence one while later sentences are still being synthesised. Listing
# tts_done first produced a negative delta and a meaningless report.
ORDER = [
    "wake", "endpoint", "asr_sent", "asr_done", "tier0_done",
    "llm_sent", "first_token", "first_sentence", "speaking", "tts_done", "done",
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

    def report(self, targets: dict[str, int]) -> None:
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