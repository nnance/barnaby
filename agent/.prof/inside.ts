// Instrument runTurn's own stages by monkeypatching fetch to timestamp.
import { loadContext } from "../src/context.ts";
import { runTurn } from "../src/agent.ts";
import { buildRegistry } from "../src/tools/registry.ts";

const cfg = {
  port: 0, host: "127.0.0.1",
  upstream: "http://nicks-mac-studio.local:8001/v1",
  timeoutMs: 55_000, maxToolRounds: 3,
  model: "qwen3.6-35b-a3b-8bit",
  context: loadContext("/tmp/CONTEXT.md"),
  weather: { unit: "fahrenheit" as const },
};
const registry = buildRegistry(cfg);
const sys = { role: "system", content: "Your answers are spoken aloud. Answer in one or two short sentences." };
const body = { model: "x", messages: [sys, { role: "user", content: "What is a good name for a cat?" }], stream: true, max_tokens: 400 };

const realFetch = globalThis.fetch;
let t0 = 0;
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const sent = Date.now() - t0;
  const r = await realFetch(u, init);
  console.log(`    fetch sent at +${sent}ms, headers back at +${Date.now() - t0}ms  (body bytes sent: ${String(init?.body ?? "").length})`);
  return r;
}) as typeof fetch;

for (let i = 0; i < 3; i++) {
  t0 = Date.now();
  let firstEmit: number | null = null;
  await runTurn(cfg, body, registry, () => { if (firstEmit === null) firstEmit = Date.now() - t0; }, AbortSignal.timeout(30_000));
  console.log(`  turn: first emit at +${firstEmit}ms, total ${Date.now() - t0}ms\n`);
}
process.exit(0);
