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
 * It is PLAIN PROSE, with no structured block, and that is the whole design.
 * Values a tool needs — the household's coordinates, say — are written into a
 * sentence, and the model passes them as tool arguments from its own context.
 * Measured 12/12 exact on the coordinates, so a second machine-readable copy
 * would buy nothing and could drift out of step with the prose.
 */

import { readFileSync } from "node:fs";
import * as log from "./log.ts";

/**
 * Read the context file. A missing file is normal, not an error — Barnaby
 * works without one, he just knows nothing about the household.
 */
export function loadContext(path: string | undefined): string {
	if (path === undefined || path === "") return "";
	try {
		const prose = readFileSync(path, "utf8").trim();
		log.info(`context: ${path} (${prose.length} chars)`);
		return prose;
	} catch (err) {
		// Say so loudly. Silently running with no context looks like the model
		// having a bad day, not like a missing file.
		const detail = err instanceof Error ? err.message : String(err);
		log.error(`context: could not read ${path} — running without it`, detail);
		return "";
	}
}
