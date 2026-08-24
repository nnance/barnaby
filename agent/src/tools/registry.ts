/**
 * The allowlist.
 *
 * A tool is callable only if it is in here. That is the whole security model
 * for now, and it is deliberate: the microphone is an attack surface, so a
 * wake-word false positive from the television must not be able to reach
 * anything that was not explicitly put within reach.
 */

import type { Config } from "../config.ts";
import type { Tool } from "./types.ts";
import { clockTool } from "./clock.ts";
import { weatherTool } from "./weather.ts";

export function buildRegistry(cfg: Config): Map<string, Tool> {
	const tools: Tool[] = [];

	// The weather tool carries no location of its own: the model passes
	// coordinates as arguments, taking them from CONTEXT.md. So it needs a
	// context to be useful, and without one it is not offered — the model
	// would have nowhere to forecast and would either refuse or invent a
	// place. No context also means no tools at all, which puts the gateway
	// back on phase 1's byte-for-byte passthrough.
	if (cfg.context.trim() !== "") {
		// The clock rides with the other tools: it is only useful alongside
		// something that returns dates, and on its own it would be a schema
		// sent on every turn for nothing.
		tools.push(clockTool({ timeZone: cfg.timeZone }));
		tools.push(weatherTool(cfg.weather));
	}

	const registry = new Map<string, Tool>();
	for (const tool of tools) registry.set(tool.name, tool);
	return registry;
}
