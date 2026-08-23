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
import { weatherTool } from "./weather.ts";

export function buildRegistry(cfg: Config): Map<string, Tool> {
	const tools: Tool[] = [];

	// Weather needs a location. Without one configured there is no sensible
	// default — a forecast for the wrong place is worse than no forecast — so
	// the tool simply is not offered.
	if (cfg.weather !== undefined) tools.push(weatherTool(cfg.weather));

	const registry = new Map<string, Tool>();
	for (const tool of tools) registry.set(tool.name, tool);
	return registry;
}
