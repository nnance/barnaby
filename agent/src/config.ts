/**
 * Configuration, from the environment with working defaults.
 *
 * The defaults assume the common case: this server and rapid-mlx on the same
 * Mac, so upstream is 127.0.0.1. Nothing here needs setting to run it.
 */

import { join } from "node:path";
import { loadContext } from "./context.ts";
import type { WeatherConfig } from "./tools/weather.ts";

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
	/**
	 * Where "the weather" means. Undefined disables the tool entirely rather
	 * than guessing — a forecast for the wrong place is worse than none.
	 */
	weather: WeatherConfig;
	/**
	 * Who Barnaby is talking to and where they live, from CONTEXT.md. Plain
	 * prose, appended to the system prompt. Anything a tool needs is written
	 * into a sentence and the model passes it as a tool argument.
	 */
	context: string;
	/**
	 * The model to ask for, overriding whatever the caller sent.
	 *
	 * The agent owns this, not the Pi. Tools only work with a model that calls
	 * them reliably, so the tool layer and the model choice are one decision —
	 * and splitting them across two machines means a model swap needs edits in
	 * two places, where missing one leaves every turn failing. Undefined passes
	 * the caller's model through unchanged, which is phase 1's behaviour.
	 */
	model?: string | undefined;
	/**
	 * How many tool rounds one turn may take before the loop gives up and lets
	 * the model answer with what it has. A ceiling, not a target: each round is
	 * a full inference, so this is the difference between a slow answer and a
	 * turn that never ends.
	 */
	maxToolRounds: number;
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
	// Beside the source by default: it is the agent's file, not the repo's, and
	// BARNABY_CONTEXT can point elsewhere.
	const context = loadContext(
		process.env.BARNABY_CONTEXT ??
			join(import.meta.dirname, "..", "CONTEXT.md"),
	);
	return {
		port: int("BARNABY_AGENT_PORT", 8100),
		host: process.env.BARNABY_AGENT_HOST ?? "0.0.0.0",
		upstream: (
			process.env.BARNABY_UPSTREAM_URL ?? "http://127.0.0.1:8001/v1"
		).replace(/\/$/, ""),
		timeoutMs: int("BARNABY_UPSTREAM_TIMEOUT_MS", 55_000),
		model: process.env.BARNABY_MODEL,
		context,
		weather: weatherConfig(),
		maxToolRounds: int("BARNABY_MAX_TOOL_ROUNDS", 3),
	};
}

/**
 * The weather tool needs no location any more — the model supplies coordinates
 * per call from CONTEXT.md. Only the unit is a deployment choice.
 */
function weatherConfig(): WeatherConfig {
	return {
		unit:
			process.env.BARNABY_TEMP_UNIT === "celsius" ? "celsius" : "fahrenheit",
	};
}
