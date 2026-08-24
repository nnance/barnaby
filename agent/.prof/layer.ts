// Compare: bare runTurn (no HTTP server) vs through createAgentServer.
import { loadContext } from "../src/context.ts";
import { runTurn } from "../src/agent.ts";
import { buildRegistry } from "../src/tools/registry.ts";
import { createAgentServer } from "../src/server.ts";

const cfg = {
  port: 0, host: "127.0.0.1",
  upstream: "http://nicks-mac-studio.local:8001/v1",
  timeoutMs: 55_000, maxToolRounds: 3,
  model: "qwen3.6-35b-a3b-8bit",
  context: loadContext("/tmp/CONTEXT.md"),
  weather: { unit: "fahrenheit" as const },
};
const registry = buildRegistry(cfg);
const body = { model: "x", messages: [
  { role: "system", content: "Your answers are spoken aloud. Answer in one or two short sentences." },
  { role: "user", content: "What is a good name for a cat?" }], stream: true, max_tokens: 400 };

const server = createAgentServer(cfg);
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };

async function bare() {
  const t0 = Date.now(); let first: number | null = null;
  await runTurn(cfg, structuredClone(body), registry, () => { if (first === null) first = Date.now() - t0; }, AbortSignal.timeout(30_000));
  return first;
}
async function viaHttp() {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rd = (r.body as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder();
  let buf = "", first: number | null = null;
  for (;;) { const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n")) !== -1) { const L = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!L.startsWith("data: ") || L.includes("[DONE]")) continue;
      try { const c = JSON.parse(L.slice(6)).choices[0]?.delta?.content; if (c && first === null) first = Date.now() - t0; } catch {} } }
  return first;
}
await bare();
for (let i = 0; i < 5; i++) {
  const b = await bare(); const h = await viaHttp();
  console.log(`  runTurn alone ${String(b).padStart(4)}ms    via HTTP ${String(h).padStart(4)}ms    http layer +${(h ?? 0) - (b ?? 0)}ms`);
}
server.close(); setTimeout(() => process.exit(0), 200);
