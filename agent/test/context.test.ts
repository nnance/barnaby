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

	it("appends the caller's prompt rather than dropping it", () => {
		// The agent knows who Barnaby is; the caller knows how its answers are
		// consumed. The Pi speaks through a speaker with no screen; a web chat
		// would want markdown. The agent cannot know which, so it must not
		// decide — it composes.
		const messages = withSystemPrompt(
			[
				{
					role: "system",
					content: "Your answers are spoken aloud. No markdown.",
				},
				{ role: "user", content: "hello" },
			],
			loadContext(write(SAMPLE)),
		);
		assert.equal(messages.length, 2);
		const prompt = String(messages[0]?.content);
		assert.match(prompt, /You are Barnaby/, "identity lost");
		assert.match(prompt, /Nick and Rhonda/, "household context lost");
		assert.match(prompt, /spoken aloud/, "the caller's guidance was dropped");
		// The caller comes last so it can qualify what precedes it.
		assert.ok(
			prompt.indexOf("Nick and Rhonda") < prompt.indexOf("spoken aloud"),
			"the caller's guidance should come last",
		);
		assert.equal(messages[1]?.content, "hello");
	});

	it("says nothing about how answers are delivered on its own", () => {
		// The agent must not assume its caller is a speaker. A web chat calling
		// the same agent should not be told to avoid markdown.
		const prompt = systemPrompt(loadContext(write(SAMPLE)));
		assert.doesNotMatch(
			prompt,
			/markdown/i,
			"presentation guidance leaked into the agent",
		);
		assert.doesNotMatch(prompt, /spoken|aloud|speaker/i);
		assert.doesNotMatch(prompt, /short sentences/i);
	});

	it("joins several system messages in order", () => {
		const messages = withSystemPrompt(
			[
				{ role: "system", content: "First rule." },
				{ role: "system", content: "Second rule." },
				{ role: "user", content: "hi" },
			],
			"",
		);
		const prompt = String(messages[0]?.content);
		assert.ok(prompt.indexOf("First rule.") < prompt.indexOf("Second rule."));
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

describe("the system prompt is stable", () => {
	it("does not change between turns", () => {
		// A prompt carrying the current time would differ every minute and
		// never match a cached prefix. rapid-mlx's prefix cache is worth about
		// 300 ms a turn here, so the clock is a tool, not a prompt line.
		const a = systemPrompt("household facts", "spoken aloud");
		const b = systemPrompt("household facts", "spoken aloud");
		assert.equal(a, b);
		assert.doesNotMatch(
			a,
			/\d{4}-\d{2}-\d{2}/,
			"a date leaked into the prompt",
		);
		assert.doesNotMatch(
			a,
			/current (date|time)/i,
			"a clock leaked into the prompt",
		);
	});
});
