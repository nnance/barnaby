/**
 * The parser phase 1 deliberately avoided writing.
 *
 * The cases that matter are the ones a real stream contains and a hand-rolled
 * fake does not: comment frames, role-only deltas, and tool arguments split
 * across chunk boundaries mid-token.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SseParser, ToolCallAccumulator } from "../src/sse.ts";

const encoder = new TextEncoder();

describe("SseParser", () => {
	it("survives a real rapid-mlx stream", () => {
		const raw = readFileSync(
			new URL("./fixtures/real-stream.sse", import.meta.url),
			"utf8",
		);
		const parser = new SseParser();
		const events = parser.push(encoder.encode(raw));

		assert.ok(
			events.some((e) => e.kind === "done"),
			"[DONE] not recognised",
		);
		// `: keepalive` must be classed as passthrough, never parsed as JSON.
		assert.ok(
			events.some(
				(e) => e.kind === "passthrough" && e.raw.includes("keepalive"),
			),
			"comment frame mishandled",
		);
		const text = events
			.filter((e) => e.kind === "chunk")
			.map((e) =>
				e.kind === "chunk" ? (e.data.choices?.[0]?.delta?.content ?? "") : "",
			)
			.join("");
		assert.ok(text.length > 20, "no content reassembled");
	});

	it("reassembles frames split across chunk boundaries", () => {
		// A token split mid-JSON is normal over TCP and fatal to a
		// line-at-a-time parser that does not hold partial lines.
		const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
		const parser = new SseParser();
		const cut = 22;
		const first = parser.push(encoder.encode(frame.slice(0, cut)));
		assert.equal(first.length, 0, "emitted an incomplete frame");
		const rest = parser.push(encoder.encode(frame.slice(cut)));
		assert.equal(rest.length, 1);
		assert.equal(
			rest[0]?.kind === "chunk"
				? rest[0].data.choices?.[0]?.delta?.content
				: null,
			"hello",
		);
	});

	it("does not throw on malformed JSON", () => {
		const parser = new SseParser();
		const events = parser.push(encoder.encode("data: {not json\n\n"));
		assert.equal(events[0]?.kind, "passthrough");
	});
});

describe("ToolCallAccumulator", () => {
	it("joins arguments streamed in fragments", () => {
		// This is how they actually arrive — a few characters per delta.
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, id: "call_1", function: { name: "get_forecast" } }]);
		acc.add([{ index: 0, function: { arguments: '{"da' } }]);
		acc.add([{ index: 0, function: { arguments: 'ys":' } }]);
		acc.add([{ index: 0, function: { arguments: " 3}" } }]);

		const calls = acc.finish();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.name, "get_forecast");
		assert.deepEqual(calls[0]?.args, { days: 3 });
	});

	it("keeps parallel calls apart by index", () => {
		const acc = new ToolCallAccumulator();
		acc.add([
			{ index: 0, id: "a", function: { name: "one", arguments: "{}" } },
		]);
		acc.add([
			{ index: 1, id: "b", function: { name: "two", arguments: "{}" } },
		]);
		const calls = acc.finish();
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.name, "one");
		assert.equal(calls[1]?.name, "two");
	});

	it("yields empty args rather than throwing on malformed JSON", () => {
		const acc = new ToolCallAccumulator();
		acc.add([
			{ index: 0, id: "a", function: { name: "x", arguments: "{oops" } },
		]);
		assert.deepEqual(acc.finish()[0]?.args, {});
	});
});

describe("reading tool names mid-stream", () => {
	// The name arrives in the first delta and the arguments stream in
	// afterwards, which is what lets a client be told a tool is running long
	// before the call is complete. If names() waited for finish() the
	// acknowledgement would land after the gap it exists to cover.
	it("returns a name before its arguments have finished arriving", () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, id: "a", function: { name: "get_forecast" } }]);
		assert.deepEqual(acc.names(), ["get_forecast"]);
		acc.add([{ index: 0, function: { arguments: '{"lat' } }]);
		assert.deepEqual(acc.names(), ["get_forecast"], "a name went missing");
	});

	it("skips a call that has an index but not yet a name", () => {
		// Announcing an empty name would have the client say a tool is running
		// without being able to say which.
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, function: { arguments: "{}" } }]);
		assert.deepEqual(acc.names(), []);
	});

	it("returns several tools in index order", () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 1, function: { name: "get_forecast" } }]);
		acc.add([{ index: 0, function: { name: "get_current_time" } }]);
		assert.deepEqual(acc.names(), ["get_current_time", "get_forecast"]);
	});
});
