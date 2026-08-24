// Intercept the exact bytes the gateway sends upstream.
import { createServer } from "node:http";
import { createAgentServer } from "../src/server.ts";
import { loadContext } from "../src/context.ts";

const UP = "http://nicks-mac-studio.local:8001";
const bodies: string[] = [];
const proxy = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", async () => {
		const body = Buffer.concat(chunks);
		if (req.url?.includes("chat/completions"))
			bodies.push(body.toString("utf8"));
		const r = await fetch(UP + req.url, {
			method: req.method,
			headers: { "content-type": "application/json" },
			body: req.method === "POST" ? body : undefined,
		});
		res.writeHead(r.status, {
			"content-type": r.headers.get("content-type") ?? "application/json",
		});
		if (r.body)
			for await (const c of r.body as unknown as AsyncIterable<Uint8Array>)
				res.write(c);
		res.end();
	});
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const pport = (proxy.address() as { port: number }).port;

const server = createAgentServer({
	port: 0,
	host: "127.0.0.1",
	upstream: `http://127.0.0.1:${pport}/v1`,
	timeoutMs: 55_000,
	maxToolRounds: 3,
	model: "qwen3.6-35b-8bit",
	context: loadContext("/tmp/CONTEXT.md"),
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	weather: { unit: "fahrenheit" as const },
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };

await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model: "x",
		messages: [{ role: "user", content: "What day is it today?" }],
		stream: true,
		max_tokens: 200,
	}),
}).then((r) => r.text());

const p = JSON.parse(bodies[0] ?? "{}");
console.log("ROUNDS:", bodies.length);
console.log(
	"tools in round 1:",
	(p.tools ?? []).map((t: { function: { name: string } }) => t.function.name),
);
console.log("\nFULL clock spec as sent:");
const clock = (p.tools ?? []).find(
	(t: { function: { name: string } }) => t.function.name === "get_current_time",
);
console.log(JSON.stringify(clock, null, 2));
server.close();
proxy.close();
setTimeout(() => process.exit(0), 200);
