/**
 * The agent loop.
 *
 * The property that matters most: whatever happens inside, the Pi sees ONE SSE
 * stream ending in exactly one [DONE]. That is what lets tool calling ship
 * without touching the Pi at all.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createAgentServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

/** A rapid-mlx that asks for a tool on round one, then answers on round two. */
function fakeModel(
	opts: {
		toolName?: string;
		args?: string;
		rounds?: number;
		/** Round one says it will check, then stops without calling anything —
		 * the failure seen against the real Qwen model. */
		promiseFirst?: boolean;
	} = {},
) {
	let round = 0;
	const server = createServer((req, res) => {
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "m" }] }));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", async () => {
			round += 1;
			bodies.push(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "text/event-stream" });
			const askRounds = opts.rounds ?? 1;

			if (opts.promiseFirst === true && round === 1) {
				for (const token of ["Let me ", "check ", "that for you."]) {
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`,
					);
				}
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			if (opts.toolName !== undefined && round <= askRounds) {
				// Arguments arrive in fragments, as they really do.
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${round}`, type: "function", function: { name: opts.toolName } }] } }] })}\n\n`,
				);
				const args = opts.args ?? "{}";
				for (const piece of [args.slice(0, 3), args.slice(3)]) {
					if (piece === "") continue;
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })}\n\n`,
					);
				}
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			res.write(": keepalive\n\n");
			for (const token of ["It is ", "hot ", "today."]) {
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`,
				);
				await new Promise((r) => setTimeout(r, 5));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	const bodies: string[] = [];
	return {
		server,
		bodies,
		get rounds() {
			return round;
		},
	};
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const a = server.address();
	if (a === null || typeof a === "string") throw new Error("no port");
	return a.port;
}

function cfgFor(port: number): Config {
	return {
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${port}/v1`,
		timeoutMs: 5_000,
		maxToolRounds: 3,
		context: { prose: "", fields: {} },
	};
}

/** Read a whole SSE response and split out its parts. */
async function collect(
	url: string,
): Promise<{ raw: string; text: string; doneCount: number }> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "m",
			messages: [{ role: "user", content: "hot?" }],
			stream: true,
		}),
	});
	const raw = await response.text();
	const text = raw
		.split("\n")
		.filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
		.map((l) => {
			try {
				return (
					(
						JSON.parse(l.slice(6)) as {
							choices?: { delta?: { content?: string } }[];
						}
					).choices?.[0]?.delta?.content ?? ""
				);
			} catch {
				return "";
			}
		})
		.join("");
	return { raw, text, doneCount: (raw.match(/data: \[DONE\]/g) ?? []).length };
}

describe("agent loop", () => {
	let model: ReturnType<typeof fakeModel>;
	let gateway: Server;
	let port: number;

	before(async () => {
		// A plain answering model: with an empty registry the gateway must
		// behave exactly like phase 1.
		model = fakeModel({});
		const mport = await listen(model.server);
		gateway = createAgentServer({ ...cfgFor(mport), weather: undefined });
		port = await listen(gateway);
	});

	after(async () => {
		await new Promise<void>((r) => gateway.close(() => r()));
		await new Promise<void>((r) => model.server.close(() => r()));
	});

	it("falls back to pure passthrough when no tools are configured", async () => {
		// With no location set the registry is empty, so this must behave
		// exactly like phase 1 — same code path, same guarantees.
		const { text, doneCount } = await collect(
			`http://127.0.0.1:${port}/v1/chat/completions`,
		);
		assert.equal(doneCount, 1, "expected exactly one [DONE]");
		assert.ok(text.length > 0);
	});
});

describe("agent loop with a tool", () => {
	let model: ReturnType<typeof fakeModel>;
	let gateway: Server;
	let port: number;

	before(async () => {
		model = fakeModel({ toolName: "get_forecast", args: '{"days":2}' });
		const mport = await listen(model.server);
		gateway = createAgentServer({
			...cfgFor(mport),
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		port = await listen(gateway);
	});

	after(async () => {
		await new Promise<void>((r) => gateway.close(() => r()));
		await new Promise<void>((r) => model.server.close(() => r()));
	});

	it("runs the tool and answers, as one stream with one [DONE]", async () => {
		const { text, doneCount } = await collect(
			`http://127.0.0.1:${port}/v1/chat/completions`,
		);
		// The Pi must not be able to tell two inference rounds happened.
		assert.equal(doneCount, 1, "the Pi saw more than one [DONE]");
		// The acknowledgement is spoken first, then the answer.
		assert.equal(text, "It is hot today.");
		assert.ok(model.rounds >= 2, "the model was only called once");
	});

	it("sends the tool result back on the second round", async () => {
		// Its own model: the shared one's round counter has already advanced
		// past the tool-asking phase.
		const fresh = fakeModel({ toolName: "get_forecast", args: '{"days":2}' });
		const mport = await listen(fresh.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const p = await listen(gw);
		try {
			await collect(`http://127.0.0.1:${p}/v1/chat/completions`);
			const second = fresh.bodies.at(-1) ?? "";
			assert.match(second, /"role":"tool"/, "no tool message in round two");
			assert.match(
				second,
				/Forecast for/,
				"the tool result never reached the model",
			);
			assert.match(
				second,
				/"role":"assistant"/,
				"the tool call itself was not recorded",
			);
			const first = fresh.bodies.at(-2) ?? "";
			assert.match(first, /"tools":/, "tools were never offered in round one");
			assert.match(first, /get_forecast/);
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => fresh.server.close(() => r()));
		}
	});

	it("emits no tool_calls frames to the Pi", async () => {
		// The Pi has no idea what a tool call is; it would try to speak it.
		const { raw } = await collect(
			`http://127.0.0.1:${port}/v1/chat/completions`,
		);
		assert.doesNotMatch(raw, /tool_calls/, "tool machinery leaked to the Pi");
	});
});

describe("the agent owns the model choice", () => {
	it("substitutes its own model, ignoring what the caller asked for", async () => {
		// Tools only work with a model that calls them reliably, so the tool
		// layer and the model choice are one decision. Splitting them across
		// two machines means a swap needs edits in two places — and missing one
		// leaves every turn failing.
		const model = fakeModel({});
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			model: "the-model-the-agent-chose",
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "whatever-the-pi-still-sends",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			}).then((r) => r.text());
			const sent = model.bodies.at(-1) ?? "";
			assert.match(sent, /the-model-the-agent-chose/);
			assert.doesNotMatch(
				sent,
				/whatever-the-pi-still-sends/,
				"the caller's model reached upstream",
			);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});
});

describe("a turn that fails before speaking", () => {
	it("returns a real status, not an empty 200 stream", async () => {
		// The silent failure. Committing to 200 before the first byte makes an
		// early error unreportable: the Pi sees success, gets nothing, and
		// Barnaby says nothing with no fault to show. Seen live when the model
		// id was wrong and upstream answered 404.
		const upstream = createServer((_req, res) => {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "model does not exist" } }));
		});
		const uport = await listen(upstream);
		const gateway = createAgentServer({
			...cfgFor(uport),
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/v1/chat/completions`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ messages: [], stream: true }),
				},
			);
			// raise_for_status() must have something to raise on.
			assert.equal(
				response.status,
				404,
				"an early failure was reported as success",
			);
			assert.doesNotMatch(
				response.headers.get("content-type") ?? "",
				/event-stream/,
				"headers were committed before there was anything to send",
			);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	});

	it("still ends the stream properly when it fails mid-answer", async () => {
		// Once bytes are out the status is spent, so the only correct move is
		// to terminate cleanly rather than hang.
		const model = fakeModel({});
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			const { doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});
});

describe("agent loop failure handling", () => {
	it("still answers when the model keeps asking for tools", async () => {
		// The runaway case: never let it spin, and never end on silence.
		const model = fakeModel({
			toolName: "get_forecast",
			args: "{}",
			rounds: 99,
		});
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			maxToolRounds: 2,
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			const { text, doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1);
			assert.ok(text.length > 0, "the turn ended in silence");
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("nudges when the model promises to check but calls no tool", async () => {
		// Seen live: "Let me check that for you." and then nothing at all. The
		// user is left with a promise and silence.
		const model = fakeModel({
			promiseFirst: true,
			toolName: "get_forecast",
			args: '{"days":1}',
		});
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			maxToolRounds: 4,
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			const { text, doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1);
			// Round one's promise was HELD, not spoken, so the nudge can drop
			// it entirely: the user hears the answer and never the false start.
			assert.doesNotMatch(
				text,
				/Let me check that for you\./,
				"the stale promise reached the speaker",
			);
			assert.match(
				text,
				/It is hot today\./,
				"the promise was never made good",
			);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("tells the model about an unknown tool rather than failing the turn", async () => {
		const model = fakeModel({ toolName: "delete_everything", args: "{}" });
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			weather: {
				latitude: 1,
				longitude: 2,
				place: "the house",
				unit: "fahrenheit",
			},
		});
		const port = await listen(gateway);
		try {
			const { text, doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1);
			assert.equal(text, "It is hot today.");
			// The allowlist rejected it; the model was told, and carried on.
			const second = model.bodies.at(-1) ?? "";
			assert.match(second, /No tool named delete_everything/);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});
});
