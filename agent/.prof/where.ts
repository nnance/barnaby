// Time each stage inside runTurn against a real upstream.
import { loadContext } from "../src/context.ts";
import { buildRegistry } from "../src/tools/registry.ts";
import { SseParser, ToolCallAccumulator } from "../src/sse.ts";
import { post } from "../src/upstream.ts";
import { toSpec } from "../src/tools/types.ts";

const cfg = {
  port: 0, host: "127.0.0.1",
  upstream: "http://nicks-mac-studio.local:8001/v1",
  timeoutMs: 55_000, maxToolRounds: 3,
  model: "qwen3.6-35b-a3b-8bit",
  context: loadContext("/tmp/CONTEXT.md"),
  weather: { unit: "fahrenheit" as const },
};
const registry = buildRegistry(cfg);
const specs = [...registry.values()].map(toSpec);
const sys = { role: "system", content: "Your answers are spoken aloud. Answer in one or two short sentences." };

async function once() {
  const t0 = Date.now();
  const payload = {
    model: cfg.model,
    messages: [{ role: "system", content: "You are Barnaby, a companion robot in a shared home.\n\nAbout the household:\n\n" + cfg.context + "\n\n" + sys.content },
               { role: "user", content: "What is a good name for a cat?" }],
    stream: true, max_tokens: 400, tools: specs,
  };
  const serialised = Date.now() - t0;
  const { response, abort } = await post(cfg, "/chat/completions", Buffer.from(JSON.stringify(payload)));
  const headers = Date.now() - t0;

  const parser = new SseParser();
  const acc = new ToolCallAccumulator();
  let firstByte: number | null = null, firstEvent: number | null = null, firstContent: number | null = null;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (firstByte === null) firstByte = Date.now() - t0;
    for (const ev of parser.push(chunk)) {
      if (firstEvent === null) firstEvent = Date.now() - t0;
      if (ev.kind !== "chunk") continue;
      const d = ev.data.choices?.[0]?.delta;
      if (d?.tool_calls) acc.add(d.tool_calls);
      if (typeof d?.content === "string" && d.content !== "" && firstContent === null) {
        firstContent = Date.now() - t0;
      }
    }
  }
  abort();
  return { serialised, headers, firstByte, firstEvent, firstContent };
}

await once();
for (let i = 0; i < 5; i++) {
  const r = await once();
  console.log(`  serialise=${String(r.serialised).padStart(3)}ms  headers=${String(r.headers).padStart(4)}ms  firstByte=${String(r.firstByte).padStart(4)}ms  firstEvent=${String(r.firstEvent).padStart(4)}ms  firstContent=${String(r.firstContent).padStart(4)}ms`);
}
process.exit(0);
