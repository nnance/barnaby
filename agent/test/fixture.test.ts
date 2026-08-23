/**
 * Properties of a REAL rapid-mlx stream, captured from the Mac Studio.
 *
 * These are here for phase 2. The moment the gateway starts parsing SSE to
 * accumulate tool calls, these are the shapes it has to survive — and they are
 * not the shapes a hand-written fake produces.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const raw = readFileSync(
	new URL("./fixtures/real-stream.sse", import.meta.url),
	"utf8",
);
const lines = raw.split("\n").filter((l) => l.trim() !== "");

describe("a real rapid-mlx stream", () => {
	it("terminates with [DONE]", () => {
		assert.equal(lines.at(-1), "data: [DONE]");
	});

	it("carries SSE comment frames a parser must skip", () => {
		// rapid-mlx emits `: keepalive`. It is not a data line, and anything
		// that assumes every line is JSON will throw on it.
		const comments = lines.filter((l) => l.startsWith(": "));
		assert.ok(
			comments.length > 0,
			"fixture has no comment frame to guard against",
		);
	});

	it("opens with a role-only delta carrying no content", () => {
		// The first frame is {"delta":{"role":"assistant"}} — no content key.
		// A parser that reads delta.content blindly gets undefined here.
		const first = JSON.parse((lines[0] as string).slice(6)) as {
			choices: { delta: Record<string, unknown> }[];
		};
		const delta = first.choices[0]?.delta;
		assert.equal(delta?.role, "assistant");
		assert.equal(delta?.content, undefined);
	});

	it("reassembles into speakable text", () => {
		const text = lines
			.filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
			.map((l) => {
				const d = JSON.parse(l.slice(6)) as {
					choices: { delta: { content?: string } }[];
				};
				return d.choices[0]?.delta.content ?? "";
			})
			.join("");
		assert.ok(text.length > 20, "no text reassembled");
		// The system prompt says spoken aloud, so no markdown should appear.
		assert.doesNotMatch(text, /[*#`]/, "model emitted markdown into speech");
	});
});
