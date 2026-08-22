/**
 * Barnaby's agent server. Sits between the Pi and rapid-mlx.
 *
 * Phase 1 is a passthrough and its whole job is to be invisible: the Pi points
 * llm_url here instead of at rapid-mlx and nothing else changes. The test for
 * "working" is that `python -m barnaby --latency` medians do not move.
 *
 * The three ways this breaks silently, all guarded below:
 *
 *   1. BUFFERING. Sentence-pipelined TTS needs token-level SSE to arrive as
 *      tokens. Anything that buffers turns time-to-first-audio into
 *      full-response latency and the answer still comes out correct, just
 *      late. No compression, and every chunk is written straight through.
 *   2. DROPPING chat_template_kwargs. The body is forwarded as bytes, never
 *      re-serialised, so enable_thinking:false survives and --no-think holds.
 *   3. SWALLOWING [DONE]. The Pi's read loop breaks on it. We never parse the
 *      stream, so we cannot lose it.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
	type Server,
} from "node:http";
import type { Config } from "./config.ts";
import * as log from "./log.ts";
import { get, post } from "./upstream.ts";

/** Read a request body with a ceiling, so a wrong request cannot exhaust memory. */
async function readBody(
	req: IncomingMessage,
	limit = 4 * 1024 * 1024,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("request body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

/**
 * An error the Pi can act on.
 *
 * Deliberately NOT a stream. httpx's raise_for_status() turns a non-2xx into a
 * clean exception and a fault face; an empty 200 stream looks like a model with
 * nothing to say, which is a far worse failure to debug.
 */
function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: { message, type: "agent_gateway_error" } });
}

/**
 * POST /v1/chat/completions — the hot path.
 *
 * Forwards the body unmodified and pipes the response back byte for byte.
 */
async function chatCompletions(
	cfg: Config,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const began = Date.now();
	const body = await readBody(req);

	// Peeked at only for the log line and the content-type of the reply. The
	// bytes that go upstream are the bytes that arrived, whatever this says.
	let messages: number | undefined;
	let stream = false;
	try {
		const parsed = JSON.parse(body.toString("utf8")) as {
			messages?: unknown[];
			stream?: boolean;
		};
		messages = Array.isArray(parsed.messages)
			? parsed.messages.length
			: undefined;
		stream = parsed.stream === true;
	} catch {
		sendError(res, 400, "request body is not valid JSON");
		log.turn({ route: "chat", status: 400, error: "bad json" });
		return;
	}

	let upstream: Awaited<ReturnType<typeof post>>;
	try {
		upstream = await post(cfg, "/chat/completions", body);
	} catch (err) {
		// Upstream unreachable: rapid-mlx down, or the wrong port.
		const detail = err instanceof Error ? err.message : String(err);
		sendError(res, 502, `upstream unreachable: ${detail}`);
		log.turn({ route: "chat", status: 502, messages, stream, error: detail });
		return;
	}

	const ttftMs = Date.now() - began;
	const { response, abort } = upstream;

	// Upstream said no. Pass the status and its body through unchanged — the
	// model's own error message is more useful than anything we would invent.
	if (!response.ok || response.body === null) {
		const text = response.body === null ? "" : await response.text();
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(text);
		abort();
		log.turn({
			route: "chat",
			status: response.status,
			messages,
			stream,
			ttftMs,
			error: "upstream error",
		});
		return;
	}

	if (!stream) {
		// Non-streaming, for curl. Not the Pi's path.
		const text = await response.text();
		res.writeHead(200, {
			"content-type":
				response.headers.get("content-type") ?? "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
		abort();
		log.turn({
			route: "chat",
			status: 200,
			messages,
			stream,
			ttftMs,
			totalMs: Date.now() - began,
			bytes: Buffer.byteLength(text),
		});
		return;
	}

	// The streaming path.
	//
	// no-transform and identity stop anything downstream from helpfully
	// buffering or compressing; X-Accel-Buffering does the same for an nginx
	// that might appear later. flushHeaders sends them before the first token
	// so the Pi's connection is live and waiting.
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"content-encoding": "identity",
		"x-accel-buffering": "no",
	});
	res.flushHeaders();

	// The Pi hung up — barge-in, or a session ending. Stop upstream generating
	// into a socket nobody is reading.
	//
	// This listens on `res`, not `req`. `req` emits close as soon as the
	// request body is fully read, which is *before* the first token — hooking
	// it there fires on every healthy turn and never on a real disconnect.
	// `res` closes only when the socket actually goes away.
	let aborted = false;
	const onClose = (): void => {
		if (res.writableEnded) return;
		aborted = true;
		abort();
	};
	res.on("close", onClose);

	let bytes = 0;
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			bytes += chunk.length;
			// Backpressure: if the Pi is not draining, wait rather than buffer
			// the whole answer in memory.
			if (!res.write(chunk)) {
				await new Promise<void>((resolve) => res.once("drain", resolve));
			}
		}
		res.end();
	} catch (err) {
		// Mid-stream failure. The headers are long gone, so there is no status
		// left to set — end the stream and let the Pi's parser run dry.
		if (!aborted) log.error("stream failed mid-flight", err);
		res.end();
	} finally {
		res.off("close", onClose);
		abort();
	}

	log.turn({
		route: "chat",
		status: 200,
		messages,
		stream,
		ttftMs,
		totalMs: Date.now() - began,
		bytes,
		aborted,
	});
}

/**
 * GET /v1/models — proxied, not faked.
 *
 * `python -m barnaby --check` health-checks this exact path. Serving a made-up
 * list would make --check pass while the model was missing, which is the
 * opposite of what a health check is for.
 */
async function models(cfg: Config, res: ServerResponse): Promise<void> {
	try {
		const response = await get(cfg, "/models");
		const text = await response.text();
		res.writeHead(response.status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
		log.turn({ route: "models", status: response.status });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		sendError(res, 502, `upstream unreachable: ${detail}`);
		log.turn({ route: "models", status: 502, error: detail });
	}
}

/** GET /healthz — ours, not the Pi's. What you curl when the Pi says the LLM is down. */
async function healthz(
	cfg: Config,
	startedAt: number,
	res: ServerResponse,
): Promise<void> {
	let upstreamOk = false;
	try {
		const response = await get(cfg, "/models", 2_000);
		upstreamOk = response.ok;
	} catch {
		upstreamOk = false;
	}
	sendJson(res, upstreamOk ? 200 : 503, {
		ok: upstreamOk,
		upstream: cfg.upstream,
		upstreamOk,
		uptimeSec: Math.round((Date.now() - startedAt) / 1000),
	});
}

/** Wire the routes onto a server. Exported so tests can bind an ephemeral port. */
export function createAgentServer(cfg: Config): Server {
	const startedAt = Date.now();

	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		const path = url.split("?")[0] ?? "/";
		const route = async (): Promise<void> => {
			if (req.method === "POST" && path === "/v1/chat/completions") {
				return await chatCompletions(cfg, req, res);
			}
			if (req.method === "GET" && path === "/v1/models")
				return await models(cfg, res);
			if (req.method === "GET" && path === "/healthz") {
				return await healthz(cfg, startedAt, res);
			}
			sendError(res, 404, `no route for ${req.method} ${path}`);
		};
		route().catch((err: unknown) => {
			log.error("unhandled request error", err);
			if (!res.headersSent) sendError(res, 500, "internal error");
			else res.end();
		});
	});

	// Node's default is 5 s, which would cut idle keep-alive connections between
	// turns and make the next turn pay for a fresh handshake.
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;
	// No socket timeout: a long answer is a long stream, and the upstream timeout
	// is the one that should fire.
	server.requestTimeout = 0;

	return server;
}
