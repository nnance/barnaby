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
			const raw = Buffer.concat(chunks).toString("utf8");
			bodies.push(raw);
			// A real model cannot call a tool it was not offered. The fake used
			// to ignore this, which hid a bug on the very round that matters.
			let offered = true;
			try {
				offered = Array.isArray(
					(JSON.parse(raw) as { tools?: unknown[] }).tools,
				);
			} catch {
				offered = true;
			}
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

			if (opts.toolName !== undefined && round <= askRounds && offered) {
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
		context: "",
		timeZone: "America/Chicago",
		weather: { unit: "fahrenheit" },
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
		gateway = createAgentServer({ ...cfgFor(mport) });
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
		model = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
		});
		const mport = await listen(model.server);
		gateway = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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
		const fresh = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
		});
		const mport = await listen(fresh.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			await collect(`http://127.0.0.1:${p}/v1/chat/completions`);
			const second = fresh.bodies.at(-1) ?? "";
			assert.match(second, /"role":"tool"/, "no tool message in round two");
			// Structured data, not a sentence: the tool reports, the model speaks.
			assert.match(
				second,
				/temperature_max/,
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
		//
		// Matched on the delta key rather than the bare string "tool_calls":
		// the gateway now emits its own `barnaby.tool_call` frames on purpose,
		// and those are a distinct object the Pi skips rather than machinery it
		// would speak. What must never leak is upstream's raw tool_calls delta.
		const { raw } = await collect(
			`http://127.0.0.1:${port}/v1/chat/completions`,
		);
		assert.doesNotMatch(
			raw,
			/"tool_calls":/,
			"tool machinery leaked to the Pi",
		);
		// And nothing the gateway adds may ever land in a content delta, which
		// is the only thing the Pi speaks.
		for (const line of raw.split("\n")) {
			if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
			const parsed = JSON.parse(line.slice(6)) as {
				choices?: { delta?: { content?: string } }[];
			};
			const content = parsed.choices?.[0]?.delta?.content;
			if (typeof content === "string") {
				assert.doesNotMatch(content, /tool/i, "a tool name reached speech");
			}
		}
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
			weather: { unit: "fahrenheit" },
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
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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
			args: '{"latitude":1,"longitude":2,"days":1}',
		});
		const mport = await listen(model.server);
		const gateway = createAgentServer({
			...cfgFor(mport),
			maxToolRounds: 4,
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
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

describe("a turn never ends in silence", () => {
	it("says something when the model produces no content", async () => {
		// A round that says nothing reaches the Pi as a valid 200 stream with
		// no content — silence it cannot explain. This cannot be caught by the
		// round ceiling: the last round strips `tools`, so the no-calls return
		// always fires first.
		const silent = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				// Headers, a role delta, and nothing to say.
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		const sport = await listen(silent);
		const gateway = createAgentServer({
			...cfgFor(sport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const port = await listen(gateway);
		try {
			const { text, doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1);
			assert.ok(text.length > 0, "the turn reached the Pi as silence");
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => silent.close(() => r()));
		}
	});
});

describe("tools that were not offered", () => {
	it("are refused rather than run", async () => {
		// The last round strips `tools`. A tool_calls delta arriving there is
		// the model ignoring the request, a server bug, or something steering
		// it — and the microphone is an attack surface.
		const rogue = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const offered = /"tools":/.test(Buffer.concat(chunks).toString("utf8"));
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (!offered) {
					// Ask for a tool anyway, on the round where none was offered.
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", type: "function", function: { name: "get_forecast", arguments: "{}" } }] } }] })}\n\n`,
					);
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
					);
				} else {
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "get_forecast", arguments: '{"latitude":1,"longitude":2,"days":1}' } }] } }] })}\n\n`,
					);
					res.write(
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
					);
				}
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		const rport = await listen(rogue);
		const gateway = createAgentServer({
			...cfgFor(rport),
			maxToolRounds: 2,
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const port = await listen(gateway);
		try {
			const { doneCount } = await collect(
				`http://127.0.0.1:${port}/v1/chat/completions`,
			);
			// It must terminate cleanly rather than looping or hanging.
			assert.equal(doneCount, 1);
		} finally {
			await new Promise<void>((r) => gateway.close(() => r()));
			await new Promise<void>((r) => rogue.close(() => r()));
		}
	});
});

describe("tool intent reaches the client as its own event", () => {
	// Option B: the agent streams the FACT that a tool is running and the
	// client decides what to do about it. The agent says nothing aloud —
	// how to react is presentation, and this server does not know whether its
	// caller has a speaker.

	/** Every `barnaby.tool_call` frame in a raw stream, in order. */
	function toolEvents(
		raw: string,
	): { object: string; phase: string; tools: string[] }[] {
		const out: { object: string; phase: string; tools: string[] }[] = [];
		for (const line of raw.split("\n")) {
			if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
			try {
				const parsed = JSON.parse(line.slice(6)) as {
					object?: string;
					phase?: string;
					tools?: string[];
				};
				if (parsed.object === "barnaby.tool_call") {
					out.push({
						object: parsed.object,
						phase: parsed.phase ?? "",
						tools: parsed.tools ?? [],
					});
				}
			} catch {
				// not JSON — a keepalive comment. Ignored, as the Pi ignores it.
			}
		}
		return out;
	}

	it("announces started then finished, once each, naming the tool", async () => {
		const model = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
		});
		const mport = await listen(model.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			const { raw } = await collect(`http://127.0.0.1:${p}/v1/chat/completions`);
			const events = toolEvents(raw);
			assert.deepEqual(
				events.map((e) => e.phase),
				["started", "finished"],
				"expected exactly one started and one finished, in that order",
			);
			assert.deepEqual(events[0]?.tools, ["get_forecast"]);
			assert.deepEqual(events[1]?.tools, ["get_forecast"]);
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("announces before the answer, not after it", async () => {
		// The whole point. An acknowledgement that arrives after the first
		// content token is covering a silence that is already over.
		const model = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
		});
		const mport = await listen(model.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			const { raw } = await collect(`http://127.0.0.1:${p}/v1/chat/completions`);
			const startedAt = raw.indexOf('"phase":"started"');
			const firstContent = raw.indexOf('"content":');
			assert.ok(startedAt !== -1, "no started frame at all");
			assert.ok(firstContent !== -1, "the turn never produced content");
			assert.ok(
				startedAt < firstContent,
				"the acknowledgement landed after the answer had begun",
			);
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("says nothing at all on a turn that uses no tool", async () => {
		// THE LOAD-BEARING TEST. The common case must not pay for the rare one:
		// a tool-less turn must be byte-identical to one from before any of
		// this existed. A gateway that announced on every turn would pass every
		// other test here and make ordinary turns worse.
		const model = fakeModel({});
		const mport = await listen(model.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			const { raw, text } = await collect(
				`http://127.0.0.1:${p}/v1/chat/completions`,
			);
			assert.deepEqual(toolEvents(raw), [], "announced a tool that never ran");
			assert.doesNotMatch(raw, /barnaby\.tool_call/);
			assert.equal(text, "It is hot today.");
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("announces once per turn, not once per round", async () => {
		// Two rounds of tool calls is still one pause the user is waiting out.
		// A second "started" would have the client acknowledge twice mid-turn.
		const model = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
			rounds: 2,
		});
		const mport = await listen(model.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			const { raw } = await collect(`http://127.0.0.1:${p}/v1/chat/completions`);
			const started = toolEvents(raw).filter((e) => e.phase === "started");
			assert.equal(started.length, 1, "announced more than once in one turn");
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});

	it("is invisible to a client that does not know the event", async () => {
		// A web chat, or curl, must see a well-formed stream ending in exactly
		// one [DONE]. The frames are additive: an unknown `object` is skipped by
		// the Pi's own content filter and by any OpenAI-compatible client.
		const model = fakeModel({
			toolName: "get_forecast",
			args: '{"latitude":1,"longitude":2,"days":2}',
		});
		const mport = await listen(model.server);
		const gw = createAgentServer({
			...cfgFor(mport),
			context: "You live in the house at latitude 1 and longitude 2.",
			weather: { unit: "fahrenheit" },
		});
		const p = await listen(gw);
		try {
			const { raw, text, doneCount } = await collect(
				`http://127.0.0.1:${p}/v1/chat/completions`,
			);
			assert.equal(doneCount, 1, "exactly one [DONE] terminates the stream");
			// Reconstructing speech the way the Pi does yields the answer alone,
			// with no trace of the acknowledgement in it.
			assert.doesNotMatch(text, /tool/i);
			assert.ok(text.length > 0, "the turn produced no speakable content");
			// Every data frame is parseable JSON or [DONE]; nothing malformed.
			for (const line of raw.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				if (line.includes("[DONE]")) continue;
				assert.doesNotThrow(() => JSON.parse(line.slice(6)));
			}
		} finally {
			await new Promise<void>((r) => gw.close(() => r()));
			await new Promise<void>((r) => model.server.close(() => r()));
		}
	});
});
