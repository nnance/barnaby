/**
 * The agent loop.
 *
 * A tool turn is two inference rounds: the model asks for a tool, we run it,
 * and we ask again with the result. The Pi must not learn any of this happened
 * — it still sees exactly one SSE stream ending in [DONE], which is why the Pi
 * needs no change for tool calling to work.
 *
 * WHAT THIS COSTS. Round one produces no speakable text at all, so a tool turn
 * has nothing to say until round two starts: roughly 1.4 s of silence against a
 * 2 s budget. Nothing is emitted into that gap on purpose — measure how bad it
 * actually is before designing around it. `tool_gap_ms` in the log is the
 * number to watch.
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
}

const encoder = new TextEncoder();

/**
 * Text that reads as "I am about to go and look this up".
 *
 * Only used to decide whether a tool-less round deserves one retry, so a false
 * positive costs an extra round and a false negative costs nothing.
 */
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
	const messages = [...body.messages];
	const specs: ToolSpec[] = [...registry.values()].map(toSpec);
	const model = body.model ?? "unknown";
	const toolsRun: string[] = [];
	let bytes = 0;
	let toolGapMs: number | undefined;
	let dispatchedAt: number | undefined;
	let nudged = false;

	for (let round = 1; round <= cfg.maxToolRounds; round++) {
		// The last permitted round drops the tools entirely. Offering them
		// while refusing to run them invites a turn that ends on a tool call
		// nobody answers, which reaches the Pi as silence.
		const last = round === cfg.maxToolRounds;
		const payload: Record<string, unknown> = {
			...body,
			messages,
			stream: true,
		};
		if (specs.length > 0 && !last) payload.tools = specs;
		else delete payload.tools;

		const upstream = await post(
			cfg,
			"/chat/completions",
			Buffer.from(JSON.stringify(payload)),
		);
		const { response, abort } = upstream;

		if (!response.ok || response.body === null) {
			abort();
			throw new Error(`upstream returned ${response.status}`);
		}

		const parser = new SseParser();
		const accumulator = new ToolCallAccumulator();
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
					if (delta?.tool_calls !== undefined)
						accumulator.add(delta.tool_calls);

					if (typeof delta?.content === "string" && delta.content !== "") {
						// Forward immediately. Buffering to see whether a tool
						// call arrives would cost every ordinary turn its
						// time-to-first-audio to help the rare tool turn.
						if (
							!sawContent &&
							dispatchedAt !== undefined &&
							toolGapMs === undefined
						) {
							toolGapMs = Date.now() - dispatchedAt;
						}
						sawContent = true;
						assistantText.push(delta.content);
						const raw = encoder.encode(`${event.raw}\n\n`);
						bytes += raw.length;
						await emit(raw);
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
			log.info("model promised to check but called no tool — nudging once");
			messages.push({ role: "assistant", content: said });
			messages.push({
				role: "user",
				content:
					"Go ahead and look that up now, then tell me the answer in one or two short sentences.",
			});
			continue;
		}

		if (calls.length === 0 || signal.aborted) {
			return {
				rounds: round,
				toolsRun,
				...(toolGapMs !== undefined && { toolGapMs }),
				bytes,
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

		if (dispatchedAt === undefined) dispatchedAt = Date.now();

		for (const call of calls) {
			const tool = registry.get(call.name);
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
	};
}
