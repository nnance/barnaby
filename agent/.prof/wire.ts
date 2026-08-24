// Intercept what the gateway actually sends upstream in production shape.
import { createServer } from "node:http";
import { createAgentServer } from "../src/server.ts";
import { loadContext } from "../src/context.ts";

const UP = "http://nicks-mac-studio.local:8001";
let captured = "";
const proxy = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    if (req.url?.includes("chat/completions")) captured = body.toString("utf8");
    const r = await fetch(UP + req.url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    if (r.body) for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
    res.end();
  });
});
await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
const pport = (proxy.address() as { port: number }).port;

const server = createAgentServer({
  port: 0, host: "127.0.0.1", upstream: `http://127.0.0.1:${pport}/v1`,
  timeoutMs: 55_000, maxToolRounds: 3, model: "qwen3.6-35b-a3b-8bit",
  context: loadContext("/tmp/CONTEXT.md"), weather: { unit: "fahrenheit" as const },
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };

await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen3.6-35b-a3b-8bit", messages: [
    { role: "system", content: "Your answers are spoken aloud. Answer in one or two short sentences." },
    { role: "user", content: "What is a good name for a cat?" }],
    stream: true, max_tokens: 400, temperature: 0.4, chat_template_kwargs: { enable_thinking: false } }),
}).then(r => r.text());

const parsed = JSON.parse(captured);
console.log("KEYS SENT UPSTREAM:", Object.keys(parsed).join(", "));
console.log("max_tokens:", parsed.max_tokens, " temperature:", parsed.temperature);
console.log("chat_template_kwargs:", JSON.stringify(parsed.chat_template_kwargs));
console.log("tools count:", (parsed.tools ?? []).length);
console.log("total body bytes:", captured.length);
console.log("\n--- SYSTEM MESSAGE SENT UPSTREAM ---");
console.log(JSON.stringify(parsed.messages[0].content));
console.log("\n--- TOOL SPEC ---");
console.log(JSON.stringify(parsed.tools[0]).slice(0,400));
server.close(); proxy.close(); setTimeout(() => process.exit(0), 200);
