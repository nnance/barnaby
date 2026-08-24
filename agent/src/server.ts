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
import { runTurn, UpstreamError, type AgentRequest } from "./agent.ts";
import type { Config } from "./config.ts";
import * as log from "./log.ts";
import { buildRegistry } from "./tools/registry.ts";
import type { Tool } from "./tools/types.ts";
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
	registry: Map<string, Tool>,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const began = Date.now();
	const body = await readBody(req);

	// Peeked at only for the log line and the content-type of the reply. The
	// bytes that go upstream are the bytes that arrived, whatever this says.
	let messages: number | undefined;
	let stream = false;
	let parsedBody: AgentRequest = { messages: [] };
	try {
		const parsed = JSON.parse(body.toString("utf8")) as AgentRequest & {
			stream?: boolean;
		};
		parsedBody = parsed;
		messages = Array.isArray(parsed.messages)
			? parsed.messages.length
			: undefined;
		stream = parsed.stream === true;
	} catch {
		sendError(res, 400, "request body is not valid JSON");
		log.turn({ route: "chat", status: 400, error: "bad json" });
		return;
	}

	// The agent path takes over whenever this server has an opinion about the
	// turn — tools to offer, a model to substitute, or a context to put in the
	// system prompt. Otherwise fall through to phase 1's byte-for-byte pipe,
	// which is strictly cheaper and cannot lose framing: there is no reason to
	// parse a stream nobody needs parsed.
	//
	// The passthrough cannot be the one to override the model, because it
	// forwards the request bytes unmodified — that is its whole guarantee.
	const agentOwnsTurn =
		registry.size > 0 || cfg.model !== undefined || cfg.context !== "";
	if (agentOwnsTurn && stream) {
		await agentStream(cfg, registry, parsedBody, res, began, messages);
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
		// abort() in a finally: it clears the upstream timeout, and reading the
		// body can throw if upstream resets the socket. Without this the timer
		// survives to fire on its own, up to timeoutMs later.
		let text = "";
		try {
			text = response.body === null ? "" : await response.text();
		} finally {
			abort();
		}
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(text);
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
		let text: string;
		try {
			text = await response.text();
		} finally {
			abort(); // clears the timeout even if the read throws
		}
		res.writeHead(200, {
			"content-type":
				response.headers.get("content-type") ?? "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
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

	// A write failing after the socket is gone must not take the process down:
	// an 'error' event with no listener is an uncaught exception, and this
	// server is shared by every turn.
	res.on("error", onClose);

	let bytes = 0;
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			if (aborted || res.writableEnded || res.destroyed) break;
			bytes += chunk.length;
			// Backpressure: if the Pi is not draining, wait rather than buffer
			// the whole answer in memory.
			//
			// The wait has to race the socket dying. A destroyed stream never
			// emits 'drain', so waiting on it alone parks here forever if the
			// Pi stalls and then disconnects — the loop never resumes, the
			// finally below never runs, and the abort never reaches upstream,
			// leaving rapid-mlx generating for a client that is gone.
			if (!res.write(chunk)) {
				await new Promise<void>((resolve) => {
					const done = (): void => {
						res.off("drain", done);
						res.off("close", done);
						res.off("error", done);
						resolve();
					};
					res.once("drain", done);
					res.once("close", done);
					res.once("error", done);
				});
			}
		}
		if (!res.writableEnded && !res.destroyed) res.end();
	} catch (err) {
		// Mid-stream failure. The headers are long gone, so there is no status
		// left to set — end the stream and let the Pi's parser run dry.
		if (!aborted) log.error("stream failed mid-flight", err);
		if (!res.writableEnded && !res.destroyed) res.end();
	} finally {
		res.off("close", onClose);
		res.off("error", onClose);
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
 * The tool-calling path.
 *
 * Owns the SSE response so that [DONE] is written in exactly one place. The
 * write plumbing mirrors the passthrough path deliberately, including the
 * drain-versus-close race: a stalled client that then dies must not park the
 * loop forever, or rapid-mlx generates for nobody.
 */
async function agentStream(
	cfg: Config,
	registry: Map<string, Tool>,
	parsedBody: AgentRequest,
	res: ServerResponse,
	began: number,
	messages: number | undefined,
): Promise<void> {
	// Headers are NOT sent yet, deliberately.
	//
	// A turn can fail before it speaks a word — upstream down, or the wrong
	// model id, which returns 404. Committing to 200 up front makes that
	// unreportable: the Pi gets an empty stream, raise_for_status() sees
	// success, and Barnaby says nothing at all with no fault to show. So the
	// status stays open until there is something to send.
	let headersSent = false;
	const startStream = (): void => {
		if (headersSent) return;
		headersSent = true;
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"content-encoding": "identity",
			"x-accel-buffering": "no",
		});
		res.flushHeaders();
	};

	const controller = new AbortController();
	let aborted = false;
	const onClose = (): void => {
		if (res.writableEnded) return;
		aborted = true;
		controller.abort();
	};
	res.on("close", onClose);
	res.on("error", onClose);

	// Same race as the passthrough path: a destroyed stream never drains.
	const write = async (bytes: Uint8Array): Promise<void> => {
		if (aborted || res.writableEnded || res.destroyed) return;
		startStream();
		if (!res.write(bytes)) {
			await new Promise<void>((resolve) => {
				const done = (): void => {
					res.off("drain", done);
					res.off("close", done);
					res.off("error", done);
					resolve();
				};
				res.once("drain", done);
				res.once("close", done);
				res.once("error", done);
			});
		}
	};

	let result: Awaited<ReturnType<typeof runTurn>> | undefined;
	let failed: string | undefined;
	let failedStatus: number | undefined;
	try {
		result = await runTurn(cfg, parsedBody, registry, write, controller.signal);
	} catch (err) {
		failed = err instanceof Error ? err.message : String(err);
		if (err instanceof UpstreamError) failedStatus = err.status;
		log.error("agent turn failed", err);
	} finally {
		if (failed !== undefined && !headersSent && !aborted && !res.destroyed) {
			// Nothing was spoken, so the status is still ours to set. Report the
			// real failure and let the Pi fault properly.
			const status = failedStatus ?? 502;
			sendError(res, status >= 400 && status < 600 ? status : 502, failed);
		} else if (!aborted && !res.writableEnded && !res.destroyed) {
			// [DONE] is written here and nowhere else. The Pi's read loop breaks
			// on it; without it the turn hangs to its 60 s timeout.
			await write(new TextEncoder().encode("data: [DONE]\n\n"));
			res.end();
		}
		res.off("close", onClose);
		res.off("error", onClose);
		controller.abort();
	}

	log.turn({
		route: "chat",
		status: failed !== undefined && !headersSent ? (failedStatus ?? 502) : 200,
		messages,
		stream: true,
		totalMs: Date.now() - began,
		bytes: result?.bytes ?? 0,
		aborted,
		...(failed !== undefined && { error: failed }),
		...(result !== undefined && {
			rounds: result.rounds,
			...(result.toolsRun.length > 0 && { tools: result.toolsRun.join(",") }),
			...(result.toolGapMs !== undefined && { toolGapMs: result.toolGapMs }),
			...(result.toolBytes > 0 && { toolBytes: result.toolBytes }),
			...(result.ackMs !== undefined && { ackMs: result.ackMs }),
		}),
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
	const registry = buildRegistry(cfg);
	if (registry.size > 0) {
		log.info(`tools: ${[...registry.keys()].join(", ")}`);
	} else {
		log.info("tools: none configured — pure passthrough");
	}

	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		const path = url.split("?")[0] ?? "/";
		const route = async (): Promise<void> => {
			if (req.method === "POST" && path === "/v1/chat/completions") {
				return await chatCompletions(cfg, registry, req, res);
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
