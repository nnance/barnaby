// Where does the gateway's time actually go on a plain-chat turn?
import { createAgentServer } from "../src/server.ts";
import { loadContext } from "../src/context.ts";

const cfg = {
  port: 0, host: "127.0.0.1",
  upstream: "http://nicks-mac-studio.local:8001/v1",
  timeoutMs: 55_000, maxToolRounds: 3,
  model: "qwen3.6-35b-a3b-8bit",
  context: loadContext("/tmp/CONTEXT.md"),
  weather: { unit: "fahrenheit" as const },
};
const server = createAgentServer(cfg);
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };

const sys = { role: "system", content: "Your answers are spoken aloud. Answer in one or two short sentences." };
const body = { model: "x", messages: [sys, { role: "user", content: "What is a good name for a cat?" }], stream: true, max_tokens: 400 };

// Time the raw upstream fetch the same way the gateway does it, for comparison.
async function rawUpstream() {
  const t0 = Date.now();
  const r = await fetch(`${cfg.upstream}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, model: cfg.model }),
  });
  const headersAt = Date.now() - t0;
  const rd = (r.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder(); let buf = "", first: number | null = null;
  for (;;) { const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n")) !== -1) { const L = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!L.startsWith("data: ") || L.includes("[DONE]")) continue;
      try { const c = JSON.parse(L.slice(6)).choices[0]?.delta?.content; if (c && first === null) first = Date.now() - t0; } catch {} } }
  return { headersAt, first };
}

async function viaGateway() {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const headersAt = Date.now() - t0;
  const rd = (r.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder(); let buf = "", first: number | null = null;
  for (;;) { const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n")) !== -1) { const L = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!L.startsWith("data: ") || L.includes("[DONE]")) continue;
      try { const c = JSON.parse(L.slice(6)).choices[0]?.delta?.content; if (c && first === null) first = Date.now() - t0; } catch {} } }
  return { headersAt, first };
}

await rawUpstream();  // warm
for (let i = 0; i < 4; i++) {
  const raw = await rawUpstream();
  const gw = await viaGateway();
  console.log(`  raw: headers=${String(raw.headersAt).padStart(4)}ms first=${String(raw.first).padStart(4)}ms   |   gateway: headers=${String(gw.headersAt).padStart(4)}ms first=${String(gw.first).padStart(4)}ms`);
}
server.close();
setTimeout(() => process.exit(0), 200);
