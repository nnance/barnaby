/**
 * One line per request, on stdout.
 *
 * The fields exist to answer one question: is anything buffering? `ttft` is
 * measured here at the gateway, so if this says 350 ms and the Pi's --latency
 * says 900 ms, the delay is between us and the Pi, not in the model.
 */

export interface TurnLog {
	route: string;
	status: number;
	/** Chat messages the Pi sent, so a runaway history is visible. */
	messages?: number | undefined;
	stream?: boolean | undefined;
	/** Gateway-side time to the first upstream byte, ms. The buffering canary. */
	ttftMs?: number | undefined;
	/** Whole request, first byte of ours to last byte to the Pi, ms. */
	totalMs?: number | undefined;
	bytes?: number | undefined;
	error?: string | undefined;
	/** Set when the Pi hung up mid-stream — barge-in, or a session ending. */
	aborted?: boolean | undefined;
	/** Inference rounds this turn took. More than one means a tool ran. */
	rounds?: number | undefined;
	/** Tools actually executed, comma-separated. */
	tools?: string | undefined;
	/** Silence a tool turn cost, ms — the number that decides whether the gap
	 * needs filling. */
	toolGapMs?: number | undefined;
	/** Bytes of tool-intent frames, apart from `bytes` so that stays a measure
	 * of answer content and stays comparable with phase 1. */
	toolBytes?: number | undefined;
	/** Request start to the `started` frame, ms — how early the client learned
	 * a tool was running. The number that decides whether an acknowledgement
	 * lands inside the gap or after it. */
	ackMs?: number | undefined;
}

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

export function turn(entry: TurnLog): void {
	const parts = [`${ts()} ${entry.route} ${entry.status}`];
	if (entry.messages !== undefined) parts.push(`msgs=${entry.messages}`);
	if (entry.stream !== undefined) parts.push(`stream=${entry.stream}`);
	if (entry.ttftMs !== undefined) parts.push(`ttft=${entry.ttftMs}ms`);
	if (entry.totalMs !== undefined) parts.push(`total=${entry.totalMs}ms`);
	if (entry.bytes !== undefined) parts.push(`bytes=${entry.bytes}`);
	if (entry.rounds !== undefined && entry.rounds > 1)
		parts.push(`rounds=${entry.rounds}`);
	if (entry.tools !== undefined) parts.push(`tools=${entry.tools}`);
	if (entry.toolGapMs !== undefined)
		parts.push(`tool_gap=${entry.toolGapMs}ms`);
	if (entry.ackMs !== undefined) parts.push(`ack=${entry.ackMs}ms`);
	if (entry.toolBytes !== undefined) parts.push(`tool_bytes=${entry.toolBytes}`);
	if (entry.aborted) parts.push("aborted");
	if (entry.error !== undefined) parts.push(`error=${entry.error}`);
	console.log(parts.join(" "));
}

export function info(message: string): void {
	console.log(`${ts()} ${message}`);
}

export function error(message: string, err?: unknown): void {
	const detail = err instanceof Error ? err.message : err;
	console.error(
		`${ts()} ${message}${detail === undefined ? "" : `: ${detail}`}`,
	);
}
