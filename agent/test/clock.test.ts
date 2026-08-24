/**
 * The clock tool.
 *
 * It exists because the model guesses otherwise: asked for Friday it returned
 * Tuesday's forecast, and on a Sunday it said "today is Tuesday".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clockTool } from "../src/tools/clock.ts";

const signal = AbortSignal.timeout(1_000);

describe("clock tool", () => {
	it("returns an ISO date that lines up with other tools", async () => {
		// The weather tool returns 2026-08-23; matching them must not require
		// the model to reformat anything.
		const result = JSON.parse(
			await clockTool({ timeZone: "America/Chicago" }).run({}, signal),
		);
		assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(result.timezone, "America/Chicago");
	});

	it("names the weekday, which is what gets asked about", async () => {
		const result = JSON.parse(
			await clockTool({ timeZone: "America/Chicago" }).run({}, signal),
		);
		const expected = new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			timeZone: "America/Chicago",
		}).format(new Date());
		assert.equal(result.weekday, expected);
	});

	it("answers in the household's zone, not the server's", async () => {
		// "Tomorrow" is local: a household in Norman asking at 7pm is already
		// on a different date from UTC.
		const chicago = JSON.parse(
			await clockTool({ timeZone: "America/Chicago" }).run({}, signal),
		);
		const tokyo = JSON.parse(
			await clockTool({ timeZone: "Asia/Tokyo" }).run({}, signal),
		);
		assert.notEqual(
			`${chicago.date} ${chicago.time}`,
			`${tokyo.date} ${tokyo.time}`,
		);
	});

	it("takes no arguments and declares almost nothing", async () => {
		// Every schema is sent on every turn, and declaring tools already costs
		// real time. This one must stay small.
		const tool = clockTool({ timeZone: "America/Chicago" });
		assert.deepEqual(Object.keys(tool.parameters.properties), []);
		const size = JSON.stringify({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}).length;
		assert.ok(
			size < 300,
			`clock schema is ${size} bytes — too fat for every turn`,
		);
	});
});
