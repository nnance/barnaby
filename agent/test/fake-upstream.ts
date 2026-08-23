/**
 * A stand-in for rapid-mlx that emits SSE the way it does: one token per frame,
 * spaced in time, terminated by [DONE].
 *
 * The spacing is the point. A gateway that buffers looks identical to one that
 * does not when the whole response arrives at once, so the test needs frames
 * that are provably separated in time.
 */

import { createServer, type Server } from "node:http";

export interface FakeOptions {
	/** Tokens to emit, one SSE frame each. */
	tokens?: string[];
	/** Gap between frames, ms. */
	gapMs?: number;
	/** Return this status instead of streaming. */
	status?: number;
	/**
	 * Emit exactly these bytes instead of generating frames, so a test can
	 * compare what the gateway produced against a known input byte for byte —
	 * including SSE comments and role-only deltas, which reconstructing text
	 * from `delta.content` would silently discard.
	 */
	raw?: string;
}

export interface Fake {
	server: Server;
	port: number;
	/** Bodies received, so a test can assert we forwarded them unmodified. */
	received: string[];
	/** Set when the client aborted mid-stream. */
	aborted: boolean;
	/** Frames actually written. Short of `tokens.length` means it was cut off. */
	framesSent: number;
	close: () => Promise<void>;
}

export async function startFake(opts: FakeOptions = {}): Promise<Fake> {
	const tokens = opts.tokens ?? ["Hello", " there", ".", " All", " set", "."];
	const gapMs = opts.gapMs ?? 25;
	const received: string[] = [];
	const state = { aborted: false, framesSent: 0 };

	const server = createServer((req, res) => {
		if (req.url === "/v1/models") {
			const body = JSON.stringify({
				object: "list",
				data: [{ id: "qwen3.8-27b-4bit", object: "model" }],
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(body);
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", async () => {
			received.push(Buffer.concat(chunks).toString("utf8"));

			if (opts.status !== undefined && opts.status >= 400) {
				res.writeHead(opts.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "upstream said no" } }));
				return;
			}

			// rapid-mlx returns plain JSON when stream is false. The gateway
			// copies the upstream content-type, so the fake has to be honest
			// about this or the non-streaming test asserts nothing real.
			let wantsStream = true;
			try {
				wantsStream =
					(
						JSON.parse(received[received.length - 1] ?? "{}") as {
							stream?: boolean;
						}
					).stream === true;
			} catch {
				wantsStream = true;
			}
			if (!wantsStream) {
				const body = JSON.stringify({
					choices: [
						{ message: { role: "assistant", content: tokens.join("") } },
					],
				});
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});

			if (opts.raw !== undefined) {
				res.end(opts.raw);
				return;
			}

			let open = true;
			res.on("close", () => {
				if (!res.writableEnded) state.aborted = true;
				open = false;
			});

			for (const token of tokens) {
				if (!open) return;
				const frame = {
					choices: [{ delta: { content: token }, index: 0 }],
				};
				// Respect backpressure, as a real server does. Without this the
				// fake dumps every frame into its own socket buffer and finishes
				// writing before a client disconnect can ever be noticed — which
				// makes `aborted` read false even when the gateway cancelled
				// correctly.
				state.framesSent += 1;
				if (!res.write(`data: ${JSON.stringify(frame)}\n\n`)) {
					await new Promise<void>((resolve) => {
						const done = (): void => {
							res.off("drain", done);
							res.off("close", done);
							resolve();
						};
						res.once("drain", done);
						res.once("close", done);
					});
				}
				if (!open) return;
				if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
			}
			if (!open) return;
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("fake upstream failed to bind");
	}

	return {
		server,
		port: address.port,
		received,
		get aborted() {
			return state.aborted;
		},
		get framesSent() {
			return state.framesSent;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
