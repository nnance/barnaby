/**
 * What day it is.
 *
 * Without this the model cannot map "Friday" or "this weekend" onto the ISO
 * dates a tool returns — and it does not decline, it guesses. Asked for Friday
 * it answered with Tuesday's forecast, and on a Sunday it said "today is
 * Tuesday". The weather tool's dates were correct throughout; the model was
 * mislabelling them.
 *
 * It is a TOOL rather than a line in the system prompt, and that is the whole
 * point: a prompt carrying the current time changes every minute, so it would
 * never match a cached prefix. rapid-mlx's prefix cache is worth ~300 ms a turn
 * here, and a clock in the prompt would quietly spend all of it.
 *
 * The definition is kept as small as it can be while still being clear, for the
 * same reason: every tool schema is sent on every turn, and declaring tools at
 * all already costs real time.
 */

import type { Tool } from "./types.ts";

export interface ClockConfig {
	/** IANA zone. "Tomorrow" is a local idea, so this is the household's, not
	 * the server's. */
	timeZone: string;
}

export function clockTool(cfg: ClockConfig): Tool {
	return {
		name: "get_current_time",
		description: "Use this tool when you need the current date or time.",
		parameters: { type: "object", properties: {} },
		readOnly: true,

		async run(): Promise<string> {
			const now = new Date();
			const parts = new Intl.DateTimeFormat("en-CA", {
				timeZone: cfg.timeZone,
				weekday: "long",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).formatToParts(now);
			const get = (type: string): string =>
				parts.find((part) => part.type === type)?.value ?? "";

			return JSON.stringify({
				// ISO, so it lines up with the dates other tools return without
				// the model having to reformat anything.
				date: `${get("year")}-${get("month")}-${get("day")}`,
				weekday: get("weekday"),
				time: `${get("hour")}:${get("minute")}`,
				timezone: cfg.timeZone,
			});
		},
	};
}
