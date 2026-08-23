/**
 * Phase 1's guarantee, tested: the gateway is invisible.
 *
 * The load-bearing test is `streams incrementally`. Every other property here
 * would still hold in a gateway that buffered the whole answer and flushed it
 * at the end — and that gateway would destroy time-to-first-audio while
 * looking perfectly correct.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Config } from "../src/config.ts";
import { createAgentServer } from "../src/server.ts";
import { type Fake, startFake } from "./fake-upstream.ts";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("no port");
	return address.port;
}

function configFor(upstreamPort: number): Config {
	return {
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}/v1`,
		timeoutMs: 5_000,
		maxToolRounds: 3,
		context: "",
		weather: { unit: "fahrenheit" },
	};
}

/** Read an SSE body, stamping the arrival time of each frame. */
async function readFrames(
	response: Response,
): Promise<{ frames: string[]; stamps: number[]; raw: string }> {
	assert.ok(response.body, "expected a body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const frames: string[] = [];
	const stamps: number[] = [];
	let raw = "";
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		raw += text;
		buffer += text;
		let cut = buffer.indexOf("\n\n");
		while (cut !== -1) {
			frames.push(buffer.slice(0, cut));
			stamps.push(Date.now());
			buffer = buffer.slice(cut + 2);
			cut = buffer.indexOf("\n\n");
		}
	}
	return { frames, stamps, raw };
}

describe("chat completions passthrough", () => {
	let fake: Fake;
	let gateway: Server;
	let port: number;

	before(async () => {
		fake = await startFake({ gapMs: 30 });
		gateway = createAgentServer(configFor(fake.port));
		port = await listen(gateway);
	});

	after(async () => {
		await new Promise<void>((resolve) => gateway.close(() => resolve()));
		await fake.close();
	});

	it("forwards the body unmodified, so chat_template_kwargs survives", async () => {
		const body = {
			model: "qwen3.8-27b-4bit",
			messages: [{ role: "user", content: "hello" }],
			stream: true,
			max_tokens: 400,
			temperature: 0.4,
			chat_template_kwargs: { enable_thinking: false },
		};
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		await readFrames(response);

		const seen = fake.received.at(-1);
		assert.ok(seen, "upstream received nothing");
		// Byte-identical, not merely equivalent — re-serialising is exactly how
		// enable_thinking goes missing and --no-think is silently lost.
		assert.equal(seen, JSON.stringify(body));
	});

	it("terminates with [DONE], which is what the Pi breaks on", async () => {
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			},
		);
		const { frames, raw } = await readFrames(response);
		assert.ok(
			raw.includes("data: [DONE]"),
			"stream did not terminate with [DONE]",
		);
		assert.equal(frames.at(-1), "data: [DONE]");
	});

	it("sets headers that stop anything downstream buffering", async () => {
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [], stream: true }),
			},
		);
		assert.match(
			response.headers.get("content-type") ?? "",
			/text\/event-stream/,
		);
		assert.match(response.headers.get("cache-control") ?? "", /no-transform/);
		assert.equal(response.headers.get("x-accel-buffering"), "no");
		await readFrames(response);
	});

	it("streams incrementally rather than buffering the answer", async () => {
		// THE test. A buffering gateway passes every other assertion in this
		// file while turning time-to-first-audio into full-response latency.
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [], stream: true }),
			},
		);
		const started = Date.now();
		const { frames, stamps } = await readFrames(response);

		assert.ok(
			frames.length >= 6,
			`expected several frames, got ${frames.length}`,
		);
		const firstAt = (stamps[0] ?? 0) - started;
		const lastAt = (stamps.at(-1) ?? 0) - started;
		// Six tokens at a 30 ms gap: the first must arrive early and the last
		// late. If they land together, something buffered.
		assert.ok(firstAt < 60, `first frame took ${firstAt}ms — buffered?`);
		assert.ok(
			lastAt - firstAt > 80,
			`whole stream spanned ${lastAt - firstAt}ms — buffered?`,
		);
	});

	it("reassembles the tokens it was given", async () => {
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [], stream: true }),
			},
		);
		const { frames } = await readFrames(response);
		const text = frames
			.filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"))
			.map((f) => {
				const parsed = JSON.parse(f.slice(6)) as {
					choices: { delta: { content?: string } }[];
				};
				return parsed.choices[0]?.delta.content ?? "";
			})
			.join("");
		assert.equal(text, "Hello there. All set.");
	});

	it("relays a real rapid-mlx stream byte for byte", async () => {
		// The response-side counterpart to the request-body byte test.
		//
		// Reconstructing text from delta.content proves far less than it looks:
		// a gateway that reformatted the JSON, dropped `: keepalive` comments,
		// or swallowed the opening role-only delta would rebuild identical text
		// and pass. Comparing the raw bytes against a stream captured from the
		// real rapid-mlx is what actually pins the passthrough contract.
		const captured = readFileSync(
			new URL("./fixtures/real-stream.sse", import.meta.url),
			"utf8",
		);
		const fake = await startFake({ raw: captured });
		const gateway = createAgentServer(configFor(fake.port));
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
			const relayed = await response.text();
			assert.equal(relayed, captured);
			// Belt and braces: the shapes a reconstructing test would lose.
			assert.ok(relayed.includes(": keepalive"), "comment frame dropped");
			assert.ok(
				relayed.includes('"delta":{"role":"assistant"}'),
				"role-only delta dropped",
			);
		} finally {
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
			await fake.close();
		}
	});

	it("proxies /v1/models, which --check health-checks", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { data: { id: string }[] };
		assert.equal(body.data[0]?.id, "qwen3.8-27b-4bit");
	});

	it("answers /healthz", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { ok: boolean };
		assert.equal(body.ok, true);
	});

	it("serves non-streaming requests for curl", async () => {
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [], stream: false }),
			},
		);
		assert.equal(response.status, 200);
		assert.doesNotMatch(
			response.headers.get("content-type") ?? "",
			/event-stream/,
		);
	});

	it("rejects a body that is not JSON", async () => {
		const response = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not json at all",
			},
		);
		assert.equal(response.status, 400);
	});

	it("404s an unknown route", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/v1/nope`);
		assert.equal(response.status, 404);
	});
});

describe("failure behaviour", () => {
	it("returns a clean 502 when upstream is down, not an empty stream", async () => {
		// An empty 200 stream looks like a model with nothing to say. A 502
		// gives httpx's raise_for_status() something to fault on.
		const gateway = createAgentServer(configFor(1));
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
			assert.equal(response.status, 502);
			const body = (await response.json()) as { error: { message: string } };
			assert.match(body.error.message, /upstream unreachable/);
		} finally {
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
		}
	});

	it("reports upstream down on /healthz", async () => {
		const gateway = createAgentServer(configFor(1));
		const port = await listen(gateway);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			assert.equal(response.status, 503);
		} finally {
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
		}
	});

	it("passes an upstream error status through unchanged", async () => {
		const fake = await startFake({ status: 500 });
		const gateway = createAgentServer(configFor(fake.port));
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
			assert.equal(response.status, 500);
		} finally {
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
			await fake.close();
		}
	});

	it("finishes the turn when a stalled client dies during backpressure", async () => {
		// The barge-in case the plain-abort test does not reach.
		//
		// A client that stops reading fills the socket buffer, so res.write()
		// returns false and the loop waits for 'drain'. A destroyed stream
		// never emits it, so waiting on 'drain' alone parks there forever: the
		// loop never resumes, the finally never runs, the turn never logs, and
		// the abort never reaches upstream — rapid-mlx generates for a client
		// that is gone until the 55 s timeout.
		//
		// The assertion is that the gateway's own turn COMPLETES. Watching the
		// upstream instead is unreliable: a fake that stops writing under
		// backpressure sees its own socket close either way, so it reports the
		// same thing whether or not the gateway recovered.
		//
		// A raw socket is required — fetch() drains in the background, so it
		// cannot produce the backpressure this depends on.
		const big = "x".repeat(200_000);
		const fake = await startFake({ gapMs: 0, tokens: Array(200).fill(big) });
		const gateway = createAgentServer(configFor(fake.port));

		// The handler logs one line per turn as its final act, so the log is
		// the signal that it ran to completion instead of parking forever.
		const realLog = console.log;
		let turnFinished = false;
		console.log = (...args: unknown[]): void => {
			if (args.join(" ").includes("chat 200")) turnFinished = true;
		};

		const port = await listen(gateway);
		try {
			const socket = connect(port, "127.0.0.1");
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const body = JSON.stringify({ messages: [], stream: true });
			socket.write(
				`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n` +
					`Content-Type: application/json\r\n` +
					`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			socket.pause(); // never read — this is what fills the buffer
			await new Promise((r) => setTimeout(r, 700));
			socket.destroy();
			await new Promise((r) => setTimeout(r, 1_500));

			// Cut off well short of all 200 frames, i.e. it did not quietly run
			// the whole generation out after the client had gone.
			assert.ok(
				fake.framesSent < 200,
				`upstream sent all ${fake.framesSent} frames after the client died`,
			);
			assert.equal(
				turnFinished,
				true,
				"gateway never finished the turn — parked on a drain that never came",
			);
		} finally {
			console.log = realLog;
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
			await fake.close();
		}
	});

	it("cancels upstream when the client hangs up mid-stream", async () => {
		// Barge-in, or a session ending. Without this, rapid-mlx keeps
		// generating into a socket nobody is reading.
		const fake = await startFake({ gapMs: 40, tokens: Array(30).fill("tok ") });
		const gateway = createAgentServer(configFor(fake.port));
		const port = await listen(gateway);
		const controller = new AbortController();
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/v1/chat/completions`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ messages: [], stream: true }),
					signal: controller.signal,
				},
			);
			assert.ok(response.body);
			const reader = response.body.getReader();
			await reader.read();
			controller.abort();
			await new Promise((r) => setTimeout(r, 250));
			assert.equal(
				fake.aborted,
				true,
				"upstream kept generating after client left",
			);
		} finally {
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
			await fake.close();
		}
	});
});
