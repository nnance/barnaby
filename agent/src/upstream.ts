/**
 * The rapid-mlx client. The only place an upstream URL is built.
 *
 * Phase 1 does not parse what comes back. It forwards the request body
 * unmodified and hands the caller the raw response — parsing SSE is where
 * [DONE] gets lost and where framing bugs live, and nothing needs it until
 * tool calling does.
 */

import type { Config } from "./config.ts";

export interface UpstreamResult {
	response: Response;
	/** Cancels the upstream generation. Call when the Pi disconnects, or
	 * rapid-mlx keeps generating into a socket nobody is reading. */
	abort: () => void;
}

/**
 * POST a JSON body upstream and return the response unread.
 *
 * `signal` chains the caller's abort (the Pi hung up) to ours, so both a
 * client disconnect and our own timeout land on the same upstream cancel.
 */
export async function post(
	cfg: Config,
	path: string,
	body: Buffer,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<UpstreamResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

	// Chain the caller's abort. Without this a client that hangs up mid-turn
	// only stops the relay once the NEXT chunk happens to arrive — and if
	// rapid-mlx stalls between tokens, it keeps generating for a socket nobody
	// is reading until the 55 s timeout. The comment above claimed this was
	// happening long before the parameter existed.
	const onAbort = (): void => controller.abort();
	if (signal !== undefined) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const detach = (): void => signal?.removeEventListener("abort", onAbort);

	try {
		const response = await fetch(`${cfg.upstream}${path}`, {
			method: "POST",
			// Forward the body byte for byte. Re-serialising it is how
			// chat_template_kwargs quietly goes missing and --no-think is lost.
			body,
			headers: { "content-type": "application/json", ...headers },
			signal: controller.signal,
		});
		// The timer must outlive this function — it guards the whole stream,
		// not just the headers. The caller clears it through abort().
		return {
			response,
			abort: () => {
				clearTimeout(timer);
				detach();
				controller.abort();
			},
		};
	} catch (err) {
		clearTimeout(timer);
		detach();
		throw err;
	}
}

/** GET upstream, used by /v1/models and the health check. */
export async function get(
	cfg: Config,
	path: string,
	timeoutMs = 5_000,
): Promise<Response> {
	return await fetch(`${cfg.upstream}${path}`, {
		signal: AbortSignal.timeout(timeoutMs),
	});
}
