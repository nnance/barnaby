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
ORDER = [
    "wake", "endpoint", "asr_sent", "asr_done", "tier0_done",
    "llm_sent", "first_token", "first_sentence", "tts_done", "speaking", "done",
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
    def perceived_ms(self) -> float | None:
        """Endpoint to first audio. The only latency a human actually feels."""
        return self.since("endpoint", "speaking")

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

        perceived = self.perceived_ms
        budget = targets["device_command_ms"] if self.tier == "tier0" \
            else targets["spoken_answer_ms"]
        verdict = "-"
        if perceived is not None:
            verdict = "OK" if perceived <= budget else f"OVER by {perceived - budget:.0f} ms"

        log.info(
            "turn [%s] %r\n%s\n  %-*s  %7.1f ms   budget %d  %s",
            self.tier, self.text, "\n".join(lines), width,
            "PERCEIVED (endpoint -> audio)", perceived or -1, budget, verdict,
        )
