/**
 * The weather tool is a data source, not a participant in the conversation.
 *
 * So these tests assert on structure, not on phrasing. Nothing here checks how
 * a temperature sounds read aloud — that is the model's job, and testing it
 * here would only pin down a decision that does not belong to this layer.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { type ForecastResult, weatherTool } from "../src/tools/weather.ts";

/** Open-Meteo's shape, as captured from the real endpoint. */
function body(days: number): string {
	const time = ["2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"].slice(
		0,
		days,
	);
	return JSON.stringify({
		timezone: "America/Chicago",
		daily_units: { temperature_2m_max: "°F" },
		daily: {
			time,
			weather_code: [2, 51, 95, 0].slice(0, days),
			temperature_2m_max: [101.2, 106.6, 108.9, 99.4].slice(0, days),
			temperature_2m_min: [73.6, 81.7, 81.8, 79.2].slice(0, days),
			precipitation_probability_max: [1, 65, 80, 5].slice(0, days),
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
		res.end(body(Number.isFinite(days) ? days : 3));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	if (addr === null || typeof addr === "string") throw new Error("no port");
	base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function run(args: Record<string, unknown>): Promise<string> {
	const tool = weatherTool({ unit: "fahrenheit" });
	const call: Record<string, unknown> = {
		latitude: 35.22257,
		longitude: -97.43948,
		days: 3,
		...args,
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
		realFetch(
			String(url).replace("https://api.open-meteo.com/v1/forecast", base),
			init,
		)) as typeof fetch;
	try {
		return await tool.run(call, AbortSignal.timeout(5_000));
	} finally {
		globalThis.fetch = realFetch;
	}
}

async function forecast(
	args: Record<string, unknown> = {},
): Promise<ForecastResult> {
	return JSON.parse(await run(args)) as ForecastResult;
}

describe("weather tool output", () => {
	it("returns structured data, not a sentence", async () => {
		const result = await forecast({ days: 3 });
		assert.equal(result.days.length, 3);
		assert.equal(result.days[0]?.date, "2026-08-23");
		assert.equal(result.days[0]?.temperature_max, 101.2);
		assert.equal(result.days[0]?.temperature_min, 73.6);
	});

	it("keeps full precision — rounding is a speech decision", async () => {
		const result = await forecast({ days: 1 });
		assert.equal(result.days[0]?.temperature_max, 101.2);
	});

	it("reports every precipitation value, however small", async () => {
		// Whether 1 percent is worth mentioning aloud is the model's call.
		const result = await forecast({ days: 3 });
		assert.equal(result.days[0]?.precipitation_probability, 1);
		assert.equal(result.days[1]?.precipitation_probability, 65);
	});

	it("translates WMO codes but keeps the raw code too", async () => {
		// A bare integer invites the model to guess, and it guesses wrongly.
		const result = await forecast({ days: 3 });
		assert.equal(result.days[0]?.weather_code, 2);
		assert.equal(result.days[0]?.condition, "partly cloudy");
		assert.equal(result.days[2]?.condition, "thunderstorm");
	});

	it("returns the timezone, so the model knows which day is today", async () => {
		const result = await forecast();
		assert.equal(result.timezone, "America/Chicago");
	});

	it("returns dates, not day names", async () => {
		// "Tomorrow" versus "Tuesday" is phrasing, and phrasing is not ours.
		const result = await forecast({ days: 2 });
		for (const day of result.days) {
			assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
		}
	});
});

describe("weather tool arguments", () => {
	it("passes the requested day count straight through", async () => {
		// No clamping to a range this tool thinks is sensible: how far ahead to
		// look is the model's decision.
		await forecast({ days: 7 });
		assert.match(lastUrl, /forecast_days=7/);
		await forecast({ days: 1 });
		assert.match(lastUrl, /forecast_days=1/);
	});

	it("rejects values that are not coordinates at all", async () => {
		// The contract, not the choice of place. Whether these coordinates are
		// the RIGHT ones is the model's problem.
		await assert.rejects(() => run({ latitude: 91 }), /latitude/);
		await assert.rejects(() => run({ longitude: 181 }), /longitude/);
		await assert.rejects(() => run({ latitude: "somewhere" }), /latitude/);
	});

	it("rejects a day count the API cannot serve", async () => {
		// 16 is Open-Meteo's own ceiling, not an opinion of ours.
		await assert.rejects(() => run({ days: 0 }), /days/);
		await assert.rejects(() => run({ days: 99 }), /days/);
	});

	it("takes no argument that exists only to build a sentence", async () => {
		const tool = weatherTool({ unit: "fahrenheit" });
		const params = Object.keys(tool.parameters.properties);
		assert.deepEqual(params.sort(), ["days", "latitude", "longitude"]);
	});
});
