/**
 * Configuration, from the environment with working defaults.
 *
 * The defaults assume the common case: this server and rapid-mlx on the same
 * Mac, so upstream is 127.0.0.1. Nothing here needs setting to run it.
 */

import { join } from "node:path";
import { loadContext, weatherFrom, type PersonalContext } from "./context.ts";
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
	weather?: WeatherConfig | undefined;
	/**
	 * Who Barnaby is talking to and where they live, from CONTEXT.md. The
	 * prose is appended to the system prompt; the frontmatter feeds tools.
	 */
	context: PersonalContext;
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
		// Env vars still win, so a deployment can override a checked-out
		// CONTEXT.md without editing it.
		weather: weatherFromEnv() ?? weatherFrom(context),
		maxToolRounds: int("BARNABY_MAX_TOOL_ROUNDS", 3),
	};
}

/**
 * Weather location, from the environment.
 *
 * Both coordinates must be present and numeric or the tool is not offered: a
 * half-configured location would silently forecast the Gulf of Guinea.
 */
function weatherFromEnv(): WeatherConfig | undefined {
	const lat = Number(process.env.BARNABY_LATITUDE);
	const lon = Number(process.env.BARNABY_LONGITUDE);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
	const unit =
		process.env.BARNABY_TEMP_UNIT === "celsius" ? "celsius" : "fahrenheit";
	return {
		latitude: lat,
		longitude: lon,
		place: process.env.BARNABY_PLACE ?? "home",
		unit,
	};
}
