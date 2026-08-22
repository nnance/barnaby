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
