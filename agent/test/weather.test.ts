/**
 * The weather tool. Everything it returns is going to be spoken aloud, so the
 * assertions are mostly about that: no symbols, no decimals, day names rather
 * than ISO dates.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { weatherTool } from "../src/tools/weather.ts";

/** Open-Meteo's shape, as captured from the real endpoint. */
function forecastBody(days: number): string {
	const time = ["2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"].slice(
		0,
		days,
	);
	return JSON.stringify({
		daily: {
			time,
			weather_code: [3, 51, 95, 0].slice(0, days),
			temperature_2m_max: [109.1, 107.7, 106.1, 99.4].slice(0, days),
			temperature_2m_min: [84.7, 82.6, 88.0, 79.2].slice(0, days),
			precipitation_probability_max: [10, 65, 80, 5].slice(0, days),
		},
	});
}

let server: Server;
let base: string;
let lastUrl = "";

before(async () => {
	server = createServer((req, res) => {
		lastUrl = req.url ?? "";
		const days = Number(
			new URL(req.url ?? "", "http://x").searchParams.get("forecast_days"),
		);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(forecastBody(Number.isFinite(days) ? days : 3));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	if (addr === null || typeof addr === "string") throw new Error("no port");
	base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

/** Point the tool at the local fake by overriding global fetch for one call. */
async function run(args: Record<string, unknown>): Promise<string> {
	const tool = weatherTool({
		latitude: 32.7767,
		longitude: -96.797,
		place: "the house",
		unit: "fahrenheit",
	});
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = String(url).replace(
			"https://api.open-meteo.com/v1/forecast",
			base,
		);
		return realFetch(path, init);
	}) as typeof fetch;
	try {
		return await tool.run(args, AbortSignal.timeout(5_000));
	} finally {
		globalThis.fetch = realFetch;
	}
}

describe("weather tool", () => {
	it("speaks day names, not ISO dates", async () => {
		const text = await run({ days: 3 });
		assert.match(text, /Today:/);
		assert.match(text, /Tomorrow:/);
		assert.doesNotMatch(text, /2026-08-2[0-9]/, "an ISO date reached speech");
	});

	it("translates WMO codes into words", async () => {
		const text = await run({ days: 3 });
		assert.match(text, /overcast/);
		assert.match(text, /drizzle/);
		assert.match(text, /thunderstorms/);
		assert.doesNotMatch(text, /\bcode\b/, "a raw weather code reached speech");
	});

	it("rounds temperatures — nobody says 109.1 degrees", async () => {
		const text = await run({ days: 1 });
		assert.match(text, /high 109 degrees/);
		assert.doesNotMatch(text, /109\.1/);
	});

	it("mentions rain only when it is worth mentioning", async () => {
		const text = await run({ days: 3 });
		// 65% and 80% are worth saying; 10% on day one is not.
		assert.match(text, /65 percent chance of rain/);
		const today = text.split("\n").find((l) => l.startsWith("Today:")) ?? "";
		assert.doesNotMatch(today, /chance of rain/, "10% chance was mentioned");
	});

	it("clamps a nonsense day count from the model", async () => {
		// The model supplies these; they are not to be trusted.
		await run({ days: 99 });
		assert.match(lastUrl, /forecast_days=7/);
		await run({ days: -5 });
		assert.match(lastUrl, /forecast_days=1/);
		await run({ days: "banana" });
		assert.match(lastUrl, /forecast_days=3/, "non-numeric did not fall back");
	});

	it("emits no markdown or symbols", async () => {
		const text = await run({ days: 4 });
		assert.doesNotMatch(
			text,
			/[*#`_|]/,
			"markup reached text destined for a speaker",
		);
		assert.doesNotMatch(text, /°/, "a degree symbol reached speech");
	});
});
