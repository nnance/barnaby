/**
 * SSE parsing, which phase 1 deliberately did not do.
 *
 * Phase 1 piped bytes precisely so it could not lose [DONE] or mangle framing.
 * Tool calling forces parsing: the gateway has to see tool_calls deltas to know
 * a tool was requested. So this is written against the shapes a REAL rapid-mlx
 * stream contains, captured in test/fixtures/real-stream.sse — including the
 * two that a naive parser gets wrong:
 *
 *   - `: keepalive` comment frames, which are not JSON and not data
 *   - an opening delta of {"role":"assistant"} with no content key
 */

export interface ToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

export interface ChunkDelta {
	role?: string;
	content?: string | null;
	tool_calls?: ToolCallDelta[];
}

export interface ParsedChunk {
	choices?: {
		index?: number;
		delta?: ChunkDelta;
		finish_reason?: string | null;
	}[];
}

/** One event from an SSE stream. */
export type SseEvent =
	| { kind: "chunk"; data: ParsedChunk; raw: string }
	| { kind: "done" }
	/** A comment, or a frame we could not parse. Forwarded, never interpreted. */
	| { kind: "passthrough"; raw: string };

/**
 * Incremental SSE line parser.
 *
 * Fed arbitrary byte chunks; yields events as whole lines arrive. Holds a
 * partial trailing line until the rest of it turns up, because a token can and
 * does get split across TCP chunks.
 */
export class SseParser {
	private buffer = "";
	private readonly decoder = new TextDecoder();

	push(bytes: Uint8Array): SseEvent[] {
		this.buffer += this.decoder.decode(bytes, { stream: true });
		const events: SseEvent[] = [];

		let cut = this.buffer.indexOf("\n");
		while (cut !== -1) {
			const line = this.buffer.slice(0, cut);
			this.buffer = this.buffer.slice(cut + 1);
			const event = this.line(line);
			if (event !== null) events.push(event);
			cut = this.buffer.indexOf("\n");
		}
		return events;
	}

	private line(line: string): SseEvent | null {
		const trimmed = line.trim();
		if (trimmed === "") return null; // frame separator
		if (!trimmed.startsWith("data: ")) {
			return { kind: "passthrough", raw: line }; // `: keepalive`
		}
		const blob = trimmed.slice(6).trim();
		if (blob === "[DONE]") return { kind: "done" };
		try {
			return {
				kind: "chunk",
				data: JSON.parse(blob) as ParsedChunk,
				raw: line,
			};
		} catch {
			// Never throw on a malformed frame: a dropped turn is worse than an
			// uninterpretable one, and the Pi ignores what it cannot read.
			return { kind: "passthrough", raw: line };
		}
	}
}

/**
 * Accumulates streamed tool_calls into whole calls.
 *
 * Arguments arrive as JSON fragments spread over many deltas — `{"da`, `ys":`,
 * ` 3}` — so nothing can be parsed until the stream ends.
 */
export class ToolCallAccumulator {
	private readonly calls = new Map<
		number,
		{ id: string; name: string; args: string }
	>();

	add(deltas: ToolCallDelta[]): void {
		for (const delta of deltas) {
			const index = delta.index ?? 0;
			const existing = this.calls.get(index) ?? { id: "", name: "", args: "" };
			if (delta.id !== undefined) existing.id = delta.id;
			if (delta.function?.name !== undefined)
				existing.name = delta.function.name;
			if (delta.function?.arguments !== undefined) {
				existing.args += delta.function.arguments;
			}
			this.calls.set(index, existing);
		}
	}

	get size(): number {
		return this.calls.size;
	}

	/**
	 * Names of the calls seen so far, in index order, skipping any not yet
	 * named. Safe to read mid-stream, which is the point: the name arrives in
	 * the first delta and the arguments stream in afterwards, so a client can
	 * be told what is running long before the call is complete.
	 */
	names(): string[] {
		return [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, call]) => call.name)
			.filter((name) => name !== "");
	}

	/** The finished calls, with arguments parsed. Bad JSON yields {} rather
	 * than throwing — the tool clamps its own inputs anyway. */
	finish(): { id: string; name: string; args: Record<string, unknown> }[] {
		return [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, call]) => {
				let args: Record<string, unknown> = {};
				try {
					if (call.args.trim() !== "") {
						args = JSON.parse(call.args) as Record<string, unknown>;
					}
				} catch {
					args = {};
				}
				return { id: call.id, name: call.name, args };
			});
	}
}
