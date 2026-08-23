/**
 * Who Barnaby is talking to, and where.
 *
 * The Pi is a client of an agent, not a caller of an LLM: it sends transcripts
 * and plays audio, and every decision about intelligence — model, tools, system
 * prompt, personal context — lives here. So this file is the agent's, and the
 * Pi never sees it.
 *
 * It is deliberately NOT committed. It holds names, a home address to within a
 * few hundred metres, and whatever else gets added; none of that belongs in a
 * public repo. `CONTEXT.example.md` is the committed template.
 *
 * The format is prose with a small YAML-ish frontmatter block. The prose is
 * appended to the system prompt, so it can say anything. The frontmatter holds
 * the handful of values tools need as numbers — a model reading "Norman,
 * Oklahoma" out of a paragraph and guessing coordinates would be wrong in a way
 * nobody notices until the forecast is for the wrong town.
 */

import { readFileSync } from "node:fs";
import * as log from "./log.ts";
import type { WeatherConfig } from "./tools/weather.ts";

export interface PersonalContext {
	/** Prose appended to the system prompt. Empty if there is no file. */
	prose: string;
	/** Structured values, for tools that need numbers rather than sentences. */
	fields: Record<string, string>;
}

const EMPTY: PersonalContext = { prose: "", fields: {} };

/**
 * Parse the frontmatter block, if there is one.
 *
 * Not YAML, deliberately: a `key: value` per line covers what tools need, and
 * a real parser would be the first runtime dependency this server has.
 */
function parse(text: string): PersonalContext {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (match === null) return { prose: text.trim(), fields: {} };

	const fields: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		// Strip quotes and any trailing comment.
		const value = trimmed
			.slice(colon + 1)
			.trim()
			.replace(/\s+#.*$/, "")
			.replace(/^["']|["']$/g, "");
		if (key !== "") fields[key] = value;
	}
	return { prose: text.slice(match[0].length).trim(), fields };
}

/**
 * Read the context file. A missing file is normal, not an error — Barnaby
 * works without one, he just knows nothing about the household.
 */
export function loadContext(path: string | undefined): PersonalContext {
	if (path === undefined || path === "") return EMPTY;
	try {
		const parsed = parse(readFileSync(path, "utf8"));
		log.info(
			`context: ${path} (${parsed.prose.length} chars of prose, ` +
				`${Object.keys(parsed.fields).length} fields)`,
		);
		return parsed;
	} catch (err) {
		// Say so loudly. Silently running with no context looks like the model
		// having a bad day, not like a missing file.
		const detail = err instanceof Error ? err.message : String(err);
		log.error(`context: could not read ${path} — running without it`, detail);
		return EMPTY;
	}
}

/** Weather location from the context file, if it is fully specified. */
export function weatherFrom(
	context: PersonalContext,
): WeatherConfig | undefined {
	const lat = Number(context.fields.latitude);
	const lon = Number(context.fields.longitude);
	// Both or neither: a half-configured location silently forecasts the
	// Gulf of Guinea, which is what 0,0 is.
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
	return {
		latitude: lat,
		longitude: lon,
		place: context.fields.place ?? "home",
		unit: context.fields.units === "celsius" ? "celsius" : "fahrenheit",
	};
}
