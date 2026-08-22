/**
 * Configuration, from the environment with working defaults.
 *
 * The defaults assume the common case: this server and rapid-mlx on the same
 * Mac, so upstream is 127.0.0.1. Nothing here needs setting to run it.
 */

export interface Config {
	/** Port we listen on. Clear of the 8000-8002 rapid-mlx block on purpose. */
	port: number;
	/** Interface we bind. 0.0.0.0 because the Pi is a different machine — the
	 * same trap rapid-mlx has, where the default bind makes it look down. */
	host: string;
	/** rapid-mlx's OpenAI-compatible base, including /v1. */
	upstream: string;
	/** Upstream request timeout. The Pi gives up at 60 s, so we must fail
	 * first — otherwise the Pi reports a timeout and we report nothing. */
	timeoutMs: number;
}

function int(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) {
		throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
	}
	return n;
}

export function load(): Config {
	return {
		port: int("BARNABY_AGENT_PORT", 8100),
		host: process.env.BARNABY_AGENT_HOST ?? "0.0.0.0",
		upstream: (
			process.env.BARNABY_UPSTREAM_URL ?? "http://127.0.0.1:8001/v1"
		).replace(/\/$/, ""),
		timeoutMs: int("BARNABY_UPSTREAM_TIMEOUT_MS", 55_000),
	};
}
