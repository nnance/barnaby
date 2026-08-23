/**
 * CONTEXT.md — the household's details, which never reach the repo.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadContext, weatherFrom } from "../src/context.ts";
import { systemPrompt, withSystemPrompt } from "../src/prompt.ts";

function write(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "barnaby-ctx-"));
	const path = join(dir, "CONTEXT.md");
	writeFileSync(path, text);
	return path;
}

const SAMPLE = `---
latitude: 35.22257
longitude: -97.43948
place: Norman
units: fahrenheit
---

You live in the kitchen of Nick and Rhonda's home in Norman, Oklahoma.
`;

describe("loading personal context", () => {
	it("splits frontmatter from prose", () => {
		const ctx = loadContext(write(SAMPLE));
		assert.equal(ctx.fields.place, "Norman");
		assert.equal(ctx.fields.latitude, "35.22257");
		assert.match(ctx.prose, /Nick and Rhonda/);
		// The frontmatter is for tools; it must not be read aloud.
		assert.doesNotMatch(ctx.prose, /latitude/);
	});

	it("treats a missing file as normal, not an error", () => {
		// Barnaby works without one; he just knows nothing about the household.
		const ctx = loadContext("/nonexistent/CONTEXT.md");
		assert.equal(ctx.prose, "");
		assert.deepEqual(ctx.fields, {});
	});

	it("accepts prose with no frontmatter at all", () => {
		const ctx = loadContext(write("Just some facts about the house.\n"));
		assert.match(ctx.prose, /Just some facts/);
		assert.deepEqual(ctx.fields, {});
	});

	it("ignores comments and strips quotes", () => {
		const ctx = loadContext(
			write(
				'---\n# a comment\nplace: "Norman"\nunits: fahrenheit  # trailing\n---\nhi\n',
			),
		);
		assert.equal(ctx.fields.place, "Norman");
		assert.equal(ctx.fields.units, "fahrenheit");
	});
});

describe("weather location from context", () => {
	it("reads coordinates as numbers", () => {
		const weather = weatherFrom(loadContext(write(SAMPLE)));
		assert.equal(weather?.latitude, 35.22257);
		assert.equal(weather?.longitude, -97.43948);
		assert.equal(weather?.place, "Norman");
		assert.equal(weather?.unit, "fahrenheit");
	});

	it("refuses a half-specified location", () => {
		// 0,0 is the Gulf of Guinea. Forecasting it silently is worse than
		// offering no forecast at all.
		assert.equal(
			weatherFrom(loadContext(write("---\nlatitude: 35.2\n---\nhi"))),
			undefined,
		);
		assert.equal(
			weatherFrom(loadContext(write("---\nplace: Norman\n---\nhi"))),
			undefined,
		);
	});
});

describe("the system prompt lives on the agent", () => {
	it("appends the household prose", () => {
		const prompt = systemPrompt(loadContext(write(SAMPLE)));
		assert.match(prompt, /You are Barnaby/);
		assert.match(prompt, /Nick and Rhonda/);
	});

	it("is just the base prompt when there is no context", () => {
		const prompt = systemPrompt({ prose: "", fields: {} });
		assert.match(prompt, /You are Barnaby/);
		assert.doesNotMatch(prompt, /About the household/);
	});

	it("replaces whatever system message the caller sent", () => {
		// The Pi still sends one. It is a client of an agent now, so its prompt
		// is ignored rather than merged — but it keeps working untouched.
		const messages = withSystemPrompt(
			[
				{ role: "system", content: "You are a pirate." },
				{ role: "user", content: "hello" },
			],
			loadContext(write(SAMPLE)),
		);
		assert.equal(messages.length, 2);
		assert.equal(messages[0]?.role, "system");
		assert.doesNotMatch(String(messages[0]?.content), /pirate/);
		assert.match(String(messages[0]?.content), /Nick and Rhonda/);
		assert.equal(messages[1]?.content, "hello");
	});

	it("keeps the conversation in order", () => {
		const messages = withSystemPrompt(
			[
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
			],
			{ prose: "", fields: {} },
		);
		assert.deepEqual(
			messages.slice(1).map((m) => m.content),
			["one", "two", "three"],
		);
	});
});
