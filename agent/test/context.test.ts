/**
 * CONTEXT.md — the household's details, which never reach the repo.
 *
 * It is plain prose on purpose. Anything a tool needs is written into a
 * sentence and the model passes it as a tool argument, so there is no second
 * machine-readable copy to drift out of step.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadContext } from "../src/context.ts";
import { systemPrompt, withSystemPrompt } from "../src/prompt.ts";

function write(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "barnaby-ctx-"));
	const path = join(dir, "CONTEXT.md");
	writeFileSync(path, text);
	return path;
}

const SAMPLE = `You live on the kitchen counter in Nick and Rhonda's home in
Norman, Oklahoma, at latitude 35.22257 and longitude -97.43948.`;

describe("loading personal context", () => {
	it("reads the file as prose", () => {
		const context = loadContext(write(SAMPLE));
		assert.match(context, /Nick and Rhonda/);
		// Coordinates stay in the prose, for the model to pass along.
		assert.match(context, /35\.22257/);
	});

	it("treats a missing file as normal, not an error", () => {
		// Barnaby works without one; he just knows nothing about the household.
		assert.equal(loadContext("/nonexistent/CONTEXT.md"), "");
		assert.equal(loadContext(undefined), "");
	});
});

describe("the system prompt lives on the agent", () => {
	it("appends the household prose", () => {
		const prompt = systemPrompt(loadContext(write(SAMPLE)));
		assert.match(prompt, /You are Barnaby/);
		assert.match(prompt, /Nick and Rhonda/);
		assert.match(prompt, /35\.22257/, "coordinates never reached the model");
	});

	it("is just the base prompt when there is no context", () => {
		const prompt = systemPrompt("");
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
			"",
		);
		assert.deepEqual(
			messages.slice(1).map((m) => m.content),
			["one", "two", "three"],
		);
	});
});
