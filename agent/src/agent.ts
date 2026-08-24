/**
 * The agent loop.
 *
 * A tool turn is two inference rounds: the model asks for a tool, we run it,
 * and we ask again with the result. The Pi must not learn any of this happened
 * — it still sees exactly one SSE stream ending in [DONE], which is why the Pi
 * needs no change for tool calling to work.
 *
 * WHAT THIS COSTS. Round one produces no speakable text at all, so a tool turn
 * has nothing to say until round two starts. `tool_gap_ms` in the log is the
 * number to watch.
 *
 * No SPEECH is emitted into that gap — but the fact of it is. On the first
 * tool_calls delta the client gets a `barnaby.tool_call` frame naming what is
 * running, and another when the tools finish, so it can explain the pause in
 * whatever way suits it: the Pi chirps, a web chat does nothing. Deciding to
 * SAY something here would be presentation, and this server does not know what
 * its caller is. See `toolFrame`.
 *
 * WHAT IT MUST NOT COST. A turn that uses no tool has to stay exactly as fast
 * as phase 1, so content frames are forwarded the instant they arrive rather
 * than being buffered to see whether a tool call shows up. Anything else would
 * trade the common case for the rare one.
 */

import type { Config } from "./config.ts";
import * as log from "./log.ts";
import { SseParser, ToolCallAccumulator } from "./sse.ts";
import type { Tool, ToolSpec } from "./tools/types.ts";
import { toSpec } from "./tools/types.ts";
import { withSystemPrompt } from "./prompt.ts";
import { post } from "./upstream.ts";

export interface Message {
	role: string;
	content?: string | null;
	tool_calls?: unknown[];
	tool_call_id?: string;
	name?: string;
}

export interface AgentRequest {
	model?: string;
	messages: Message[];
	[key: string]: unknown;
}

/** What the caller does with bytes bound for the Pi. */
export type Emit = (bytes: Uint8Array) => Promise<void> | void;

export interface AgentResult {
	rounds: number;
	toolsRun: string[];
	/** Silence a tool turn cost: first tool dispatch to the next round's first
	 * content token. Undefined when no tool ran. */
	toolGapMs?: number;
	bytes: number;
	/** Bytes of tool-intent frames, apart from `bytes` so that stays a measure
	 * of answer content and stays comparable with phase 1. */
	toolBytes: number;
	/** Turn start to the `started` frame, ms. How early the client learned a
	 * tool was running — the number that says whether an acknowledgement lands
	 * inside the gap or after it. Undefined when nothing was announced. */
	ackMs?: number;
}

const encoder = new TextEncoder();

/**
 * An upstream failure, carrying its status.
 *
 * The status matters: a turn that dies before speaking must reach the Pi as a
 * non-2xx, so httpx's raise_for_status() raises and Barnaby shows a fault. An
 * empty 200 stream is silence he cannot explain.
 */
export class UpstreamError extends Error {
	// Plain fields, not constructor parameter properties: those emit code, and
	// Node's strip-only type removal rejects them outright.
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail = "") {
		super(
			`upstream returned ${status}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
		);
		this.name = "UpstreamError";
		this.status = status;
		this.detail = detail;
	}
}

/**
 * Text that reads as "I am about to go and look this up".
 *
 * Only used to decide whether a tool-less round deserves one retry, so a false
 * positive costs an extra round and a false negative costs nothing.
 */
/**
 * How much may be held before it is certainly an answer, not a promise.
 *
 * "Let me check the forecast for you." is 34 characters. Past this the model is
 * answering, and holding any longer would cost real time-to-first-audio.
 */
const PROMISE_MAX = 60;

/** Spoken when a round produces no content at all, so a turn never ends mute. */
const NOTHING_TO_SAY = "Sorry, I could not work that one out.";

/** A promise starts this way. Anything else is an answer and must not be held. */
const PROMISE_PREFIX =
	/^\s*(let me|i'?ll|i will|i'?m going to|one moment|hold on|checking|let'?s|sure[,!.]?\s*(let me|i'?ll)?)/i;

const PROMISE =
	/\b(let me|i'?ll|i will|going to|one moment|hold on|checking|let's)\b.*\b(check|look|see|fetch|find|grab|pull)\b/i;

/** Frame arbitrary text as an SSE content delta the Pi will speak. */
function contentFrame(text: string, model: string): Uint8Array {
	return encoder.encode(
		`data: ${JSON.stringify({
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: { content: text } }],
		})}\n\n`,
	);
}

/** The object type carrying tool intent. Deliberately not a chat chunk. */
export const TOOL_EVENT = "barnaby.tool_call";

/**
 * Tell the client a tool is running, so it can explain the pause itself.
 *
 * WHY THIS IS NOT A CONTENT DELTA. A content delta is spoken by anything that
 * receives it — there is no way to opt out, and a web chat would print "let me
 * check" mid-answer. A distinct `object` is skipped by every OpenAI-compatible
 * client, including the Pi's own `choices[0].delta.content` filter, so this is
 * additive: a client that has never heard of it behaves exactly as before.
 *
 * WHY THE AGENT DOES NOT JUST SAY SOMETHING. What is happening is a fact and
 * belongs here. How to react is presentation, and the agent cannot know whether
 * its caller has a speaker, a screen, or neither — the same split that keeps
 * spoken-answer guidance in the Pi's system prompt rather than this one. The Pi
 * has a chirp and a face that cost nothing; a spoken acknowledgement costs a
 * Kokoro round trip inside the very gap it is trying to cover.
 *
 * Arguments are never sent. The client has no use for them, and they carry the
 * household's coordinates.
 */
function toolFrame(phase: "started" | "finished", tools: string[]): Uint8Array {
	return encoder.encode(
		`data: ${JSON.stringify({
			object: TOOL_EVENT,
			phase,
			tools,
		})}\n\n`,
	);
}

/**
 * Run one turn to completion, streaming to `emit`.
 *
 * Returns once the model has produced a final answer, or once the round budget
 * is spent. Never emits [DONE] — the caller owns terminating the stream, so
 * there is exactly one place it can be forgotten.
 */
export async function runTurn(
	cfg: Config,
	body: AgentRequest,
	registry: Map<string, Tool>,
	emit: Emit,
	signal: AbortSignal,
): Promise<AgentResult> {
	// The agent owns the system prompt, same as it owns the model. Whatever the
	// Pi sent is replaced: it is a client of an agent, not a caller of an LLM.
	const messages = withSystemPrompt(body.messages, cfg.context);
	const specs: ToolSpec[] = [...registry.values()].map(toSpec);
	// The agent decides which model serves the turn. The Pi asks for an answer;
	// which model produces it is an implementation detail of this server.
	const model = cfg.model ?? body.model ?? "unknown";
	const toolsRun: string[] = [];
	let bytes = 0;
	let toolGapMs: number | undefined;
	let dispatchedAt: number | undefined;
	let nudged = false;
	// Once per turn, spanning rounds: a second round asking for another tool is
	// a pause the client has already been told about and is still waiting out.
	let announced = false;
	const startedAt = Date.now();
	let ackMs: number | undefined;
	// Counted apart from `bytes` so that stays a measure of answer content and
	// stays comparable with phase 1's logs.
	let toolBytes = 0;

	for (let round = 1; round <= cfg.maxToolRounds; round++) {
		// The last permitted round drops the tools entirely. Offering them
		// while refusing to run them invites a turn that ends on a tool call
		// nobody answers, which reaches the Pi as silence.
		const last = round === cfg.maxToolRounds;
		const payload: Record<string, unknown> = {
			...body,
			model,
			messages,
			stream: true,
		};
		if (specs.length > 0 && !last) payload.tools = specs;
		else delete payload.tools;

		const upstream = await post(
			cfg,
			"/chat/completions",
			Buffer.from(JSON.stringify(payload)),
			{},
			signal,
		);
		const { response, abort } = upstream;

		if (!response.ok || response.body === null) {
			const detail =
				response.body === null ? "" : await response.text().catch(() => "");
			abort();
			throw new UpstreamError(response.status, detail);
		}

		const parser = new SseParser();
		const accumulator = new ToolCallAccumulator();
		// Tools on offer means this round might turn out to be a tool call, so
		// anything it says is held until we know.
		const canCallTool = specs.length > 0 && !last;
		const held: string[] = [];
		// Set once this round's content is known to be a real answer rather
		// than a false start, after which nothing more is buffered.
		let releasedHold = false;
		let sawContent = false;
		let finish: string | null = null;
		const assistantText: string[] = [];

		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				if (signal.aborted) break;
				for (const event of parser.push(chunk)) {
					if (event.kind === "done") continue; // we terminate, not upstream
					if (event.kind === "passthrough") continue;

					const choice = event.data.choices?.[0];
					const delta = choice?.delta;
					if (choice?.finish_reason != null) finish = choice.finish_reason;
					if (delta?.tool_calls !== undefined) {
						accumulator.add(delta.tool_calls);
						// Announce the moment the model commits to a tool, not
						// when the round finishes. Waiting for the round to end
						// puts the acknowledgement AFTER the silence it should
						// have covered.
						//
						// Measured 2026-08-24 over 12 live turns on the alias:
						// the first tool_calls delta arrives at a median of
						// 546 ms (250-971), and carries the tool NAME in that
						// first delta — arguments stream afterwards. So this
						// fires early enough to be worth having, which is what
						// the older ~2500 ms figure said it would not be. That
						// figure predated the alias fix.
						//
						// Once per turn, not once per call: two tools in one
						// round is still one pause to explain. Names may still
						// be empty here if a delta carries only an index, in
						// which case the next one will do.
						if (!announced) {
							const names = accumulator.names();
							if (names.length > 0) {
								announced = true;
								ackMs = Date.now() - startedAt;
								const frame = toolFrame("started", names);
								toolBytes += frame.length;
								await emit(frame);
							}
						}
					}

					if (typeof delta?.content === "string" && delta.content !== "") {
						if (
							!sawContent &&
							dispatchedAt !== undefined &&
							toolGapMs === undefined
						) {
							toolGapMs = Date.now() - dispatchedAt;
						}
						sawContent = true;
						assistantText.push(delta.content);

						// While tools are on offer, hold the model's words back.
						//
						// Measured: on a tool turn its narration ("Let me check
						// that for you") does not arrive until ~2.3 s, which is
						// AFTER the silence it was meant to cover, and is then
						// followed by another ~2.1 s wait. Speaking it there is
						// worse than useless — it delays the answer to say
						// something the user has already finished waiting for.
						//
						// Hold ONLY while this still looks like a false start.
						//
						// The point of holding is to drop a "let me check that
						// for you" that never becomes a tool call. But a real
						// answer must not be held: measured, buffering a plain
						// answer delivered all 400 tokens in an 8 ms burst
						// after 6 s of silence, which destroys the
						// sentence-pipelined TTS phase 1 exists to protect.
						//
						// So the buffer is released the moment what has been
						// said stops reading like a promise. A promise is short
						// and formulaic; anything longer is the answer itself.
						if (canCallTool && !nudged && !releasedHold) {
							held.push(event.raw);
							const soFar = assistantText.join("");
							if (soFar.length > PROMISE_MAX || !PROMISE_PREFIX.test(soFar)) {
								// Not a false start. Flush and stream from here
								// on, so this turn is byte-identical to one
								// that never buffered.
								releasedHold = true;
								for (const raw of held) {
									const frame = encoder.encode(`${raw}\n\n`);
									bytes += frame.length;
									await emit(frame);
								}
								held.length = 0;
							}
						} else {
							const raw = encoder.encode(`${event.raw}\n\n`);
							bytes += raw.length;
							await emit(raw);
						}
					}
				}
			}
		} finally {
			abort();
		}

		const calls = accumulator.finish().filter((c) => c.name !== "");

		// The "promise without the call" failure. The model sometimes says it
		// will look something up, stops, and never asks for the tool — leaving
		// the user with "let me check that for you" and silence, which is worse
		// than refusing outright. Observed live, though it did not reproduce in
		// 8/8 probes, so it is nondeterministic rather than systematic.
		//
		// Nudge once, and only when there is something to nudge about: tools
		// were on offer, nothing was called, and what was said reads like a
		// promise. What has been spoken has already gone to the Pi and cannot
		// be recalled, so the retry appends rather than replaces.
		const said = assistantText.join("");
		if (
			calls.length === 0 &&
			!signal.aborted &&
			!last &&
			specs.length > 0 &&
			!nudged &&
			PROMISE.test(said)
		) {
			nudged = true;
			// The promise was held, not spoken, so it can simply be dropped —
			// the user never hears it, and the retry's answer is the only thing
			// that reaches them. This is why round-one content is buffered.
			held.length = 0;
			log.info("model promised to check but called no tool — nudging once");
			messages.push({ role: "assistant", content: said });
			messages.push({
				role: "user",
				content:
					"Go ahead and look that up now, then tell me the answer in one or two short sentences.",
			});
			continue;
		}

		// A real answer: release what was held, verbatim and in order. An
		// ordinary turn must be byte-identical to one that never buffered.
		if (held.length > 0) {
			for (const raw of held) {
				const frame = encoder.encode(`${raw}\n\n`);
				bytes += frame.length;
				await emit(frame);
			}
			held.length = 0;
		}

		if (calls.length === 0 || signal.aborted) {
			// A round that said nothing reaches the Pi as a valid 200 stream
			// with no content — silence it cannot explain, which is the exact
			// failure the error handling exists to prevent. It cannot be caught
			// by the ceiling below: the last round strips `tools`, so calls is
			// always empty there and this return always fires first.
			if (!sawContent && !signal.aborted && bytes === 0) {
				const frame = contentFrame(NOTHING_TO_SAY, model);
				bytes += frame.length;
				await emit(frame);
				log.info(
					"model produced no content — said so rather than ending silent",
				);
			}
			return {
				rounds: round,
				toolsRun,
				...(toolGapMs !== undefined && { toolGapMs }),
				bytes,
				toolBytes,
				...(ackMs !== undefined && { ackMs }),
			};
		}

		// A tool was asked for. Record what the model said (usually nothing)
		// plus the call itself, or the next round has no idea why the tool
		// results are in its context.
		messages.push({
			role: "assistant",
			content: assistantText.join("") || null,
			tool_calls: calls.map((c) => ({
				id: c.id,
				type: "function",
				function: { name: c.name, arguments: JSON.stringify(c.args) },
			})),
		});

		// A tool is about to run, and the held narration is stale. Drop it and
		// say something now, so the pause that follows is explained while it
		// happens. Only once per turn: a second "let me check" mid-answer would
		// be worse than silence.
		held.length = 0;
		if (dispatchedAt === undefined) dispatchedAt = Date.now();
		// Nothing synthetic is spoken here. Measured: the model's own
		// tool_calls delta does not arrive until a median of ~2500 ms, so an
		// acknowledgement triggered by it lands AFTER the silence it was meant
		// to cover — which is exactly the complaint. Firing one before the
		// round starts would mean saying "let me check" on every turn,
		// including ones needing no tool. See PLAN.md.

		for (const call of calls) {
			// Not offered means not reachable. The last round strips `tools`
			// from the payload, so a tool_calls delta arriving there is the
			// model ignoring the request, a server bug, or something steering
			// it — and the microphone is an attack surface. Refuse rather than
			// run it.
			const offered = specs.length > 0 && !last;
			const tool = offered ? registry.get(call.name) : undefined;
			let result: string;
			if (tool === undefined) {
				// Not in the allowlist. Tell the model plainly rather than
				// failing the turn — it can say it cannot do that.
				result = `No tool named ${call.name} is available.`;
				log.info(`tool rejected: ${call.name} is not in the registry`);
			} else {
				const began = Date.now();
				try {
					result = await tool.run(call.args, signal);
					log.info(`tool ${call.name} ok in ${Date.now() - began}ms`);
				} catch (err) {
					// A failed tool must not kill the turn. The model can tell
					// the user the forecast is unavailable, which is a far
					// better outcome than silence.
					const detail = err instanceof Error ? err.message : String(err);
					result = `The ${call.name} tool failed: ${detail}`;
					log.error(`tool ${call.name} failed`, err);
				}
				toolsRun.push(call.name);
			}
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				name: call.name,
				content: result,
			});
		}

		// Tools are done and round two is about to start. Say so, so a client
		// running a "thinking" animation can stop it on an event rather than on
		// a guess — and so a stuck tool is visible as a gap between started and
		// finished rather than as undifferentiated silence.
		//
		// Only if a `started` went out: without one this would be the first the
		// client had heard of any tool, which is worse than saying nothing.
		if (announced && !signal.aborted) {
			const frame = toolFrame("finished", toolsRun);
			toolBytes += frame.length;
			await emit(frame);
		}

		// The client may have gone while the tools ran. Starting another
		// inference round for a socket nobody is reading is the exact leak the
		// abort plumbing exists to prevent — and tools that ignore the signal
		// (the clock is synchronous) return normally regardless.
		if (signal.aborted) {
			return {
				rounds: round,
				toolsRun,
				...(toolGapMs !== undefined && { toolGapMs }),
				bytes,
				toolBytes,
				...(ackMs !== undefined && { ackMs }),
			};
		}

		if (finish !== null && finish !== "tool_calls") {
			// Model stopped for some other reason but still asked for a tool.
			// Run it anyway (done above), then let the next round speak.
		}
	}

	// Round budget spent. Rather than end on silence, say something true.
	const apology = "Sorry, I could not work that one out.";
	const frame = contentFrame(apology, model);
	bytes += frame.length;
	await emit(frame);
	log.info(`tool loop hit the ${cfg.maxToolRounds}-round ceiling`);
	return {
		rounds: cfg.maxToolRounds,
		toolsRun,
		...(toolGapMs !== undefined && { toolGapMs }),
		bytes,
		toolBytes,
		...(ackMs !== undefined && { ackMs }),
	};
}
