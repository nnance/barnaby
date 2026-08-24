/**
 * Daily forecast, from Open-Meteo.
 *
 * The first tool, and deliberately the dullest one that is still genuinely
 * useful: no API key, no account, so it stays true to the zero-dependency shape
 * of the rest of the server.
 *
 * IT IS A DATA SOURCE, NOT A PARTICIPANT IN THE CONVERSATION. Structured in,
 * structured out. It takes no argument that exists only to build a sentence,
 * and it returns no prose. Deciding whether a 10% chance of rain is worth
 * mentioning, whether to say "Tuesday" or "the day after tomorrow", or how to
 * phrase 101 degrees for a speaker are all judgments the model is better at
 * and already makes for everything else it says.
 *
 * It also does not second-guess the model. Arguments are checked against the
 * contract — a latitude is a number between -90 and 90 — and nothing more.
 * Whether those coordinates are the *right* place is the model's problem; if it
 * gets that wrong the answer is a better model, not a tool that argues with it.
 */

import type { Tool } from "./types.ts";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO weather codes as their standard descriptions.
 *
 * Passing a bare integer would invite the model to guess, and it guesses
 * plausibly and wrongly. These are labels for a machine to read, not phrasing
 * for a speaker — the model rewrites them for that.
 */
const CONDITIONS: Record<number, string> = {
	0: "clear sky",
	1: "mainly clear",
	2: "partly cloudy",
	3: "overcast",
	45: "fog",
	48: "depositing rime fog",
	51: "light drizzle",
	53: "moderate drizzle",
	55: "dense drizzle",
	56: "light freezing drizzle",
	57: "dense freezing drizzle",
	61: "slight rain",
	63: "moderate rain",
	65: "heavy rain",
	66: "light freezing rain",
	67: "heavy freezing rain",
	71: "slight snowfall",
	73: "moderate snowfall",
	75: "heavy snowfall",
	77: "snow grains",
	80: "slight rain showers",
	81: "moderate rain showers",
	82: "violent rain showers",
	85: "slight snow showers",
	86: "heavy snow showers",
	95: "thunderstorm",
	96: "thunderstorm with slight hail",
	99: "thunderstorm with heavy hail",
};

interface Response {
	timezone?: string;
	daily_units?: Record<string, string>;
	daily?: {
		time?: string[];
		weather_code?: number[];
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		precipitation_probability_max?: number[];
	};
}

/** One day of forecast, as data. */
export interface ForecastDay {
	date: string;
	/**
	 * The weekday, spelled out.
	 *
	 * The model cannot reliably work out that Friday is the 28th when today is
	 * Sunday the 23rd — asked for Friday it returned Tuesday's numbers 4 times
	 * in 6, with correct ISO dates in front of it, and adding today's date as
	 * an anchor did not help. So it is not asked to: every row is labelled with
	 * the day it actually is, and matching "Friday" to it needs no arithmetic.
	 */
	weekday: string;
	condition: string;
	weather_code: number;
	temperature_max: number | null;
	temperature_min: number | null;
	precipitation_probability: number | null;
}

export interface ForecastResult {
	latitude: number;
	longitude: number;
	timezone: string;
	/**
	 * Today's date at the location, so a weekday name can be resolved without
	 * guessing.
	 *
	 * The model does not know what day it is and does not know that it does not
	 * know: asked for Friday it returned Monday's, Tuesday's or Wednesday's
	 * numbers, right 2 times in 6, while every date in this payload was
	 * correct. It was mislabelling rows. Anchoring the array to a date the tool
	 * worked out itself means it cannot do that without contradicting data it
	 * was handed in the same breath.
	 *
	 * The tool resolves this, not the model — it already knows the timezone,
	 * and asking the model for a date it might compute wrongly would put the
	 * bug back on the input side.
	 */
	today: string;
	temperature_unit: string;
	days: ForecastDay[];
}

export interface WeatherConfig {
	/** Unit the forecast is requested in. A deployment choice, not a per-call one. */
	unit: "fahrenheit" | "celsius";
}

/**
 * The weekday for an ISO date, in the forecast's own timezone.
 *
 * Parsed as UTC noon rather than midnight: midnight in a zone behind UTC lands
 * on the previous day, and every label comes out one off.
 */
function weekdayOf(iso: string, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(
		new Date(`${iso}T12:00:00Z`),
	);
}

/** Reject values that are not coordinates at all. Not a judgment about place. */
function coordinate(value: unknown, limit: number, name: string): number {
	const n = Number(value);
	if (!Number.isFinite(n) || Math.abs(n) > limit) {
		throw new Error(`${name} must be a number between -${limit} and ${limit}`);
	}
	return n;
}

export function weatherTool(cfg: WeatherConfig): Tool {
	return {
		name: "get_forecast",
		description:
			"Get the daily weather forecast for a location: conditions, high and low " +
			"temperature, and chance of precipitation. Returns structured data for the " +
			"requested days starting today. Use it for any question about weather, " +
			"temperature, rain, snow, or what to wear.",
		parameters: {
			type: "object",
			properties: {
				latitude: {
					type: "number",
					description: "Latitude of the location, between -90 and 90.",
				},
				longitude: {
					type: "number",
					description: "Longitude of the location, between -180 and 180.",
				},
				days: {
					type: "integer",
					description:
						"Number of days to return, starting with today. 1 is today only, " +
						"2 includes tomorrow, and so on.",
					minimum: 1,
					maximum: 16,
				},
			},
			required: ["latitude", "longitude", "days"],
		},
		readOnly: true,

		async run(args, signal): Promise<string> {
			const latitude = coordinate(args.latitude, 90, "latitude");
			const longitude = coordinate(args.longitude, 180, "longitude");

			// Open-Meteo's own ceiling. A hard limit of the API, not an opinion
			// about how far ahead anyone should be asking.
			// The schema says integer and the message says whole number, so
			// silently truncating 1.9 to 1 would be the validation layer
			// disagreeing with its own contract.
			const days = Number(args.days);
			if (!Number.isInteger(days) || days < 1 || days > 16) {
				throw new Error("days must be a whole number between 1 and 16");
			}

			const url =
				`${ENDPOINT}?latitude=${latitude}&longitude=${longitude}` +
				"&daily=weather_code,temperature_2m_max,temperature_2m_min," +
				"precipitation_probability_max" +
				`&temperature_unit=${cfg.unit}&timezone=auto&forecast_days=${days}`;

			const response = await fetch(url, { signal });
			if (!response.ok) {
				throw new Error(`weather service returned ${response.status}`);
			}
			const data = (await response.json()) as Response;
			const daily = data.daily;
			const times = daily?.time ?? [];
			if (times.length === 0)
				throw new Error("weather service returned no forecast");

			// Open-Meteo returns dates in the location's own timezone, so today
			// must be resolved in that zone too — at 7pm in Norman the server's
			// idea of "today" may already be tomorrow's date in UTC.
			const timezone = data.timezone ?? "UTC";
			const today = new Intl.DateTimeFormat("en-CA", {
				timeZone: timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(new Date());

			const result: ForecastResult = {
				latitude,
				longitude,
				today,
				timezone,
				temperature_unit: data.daily_units?.temperature_2m_max ?? cfg.unit,
				days: times.map((date, i) => ({
					date,
					weekday: weekdayOf(date, timezone),
					weather_code: daily?.weather_code?.[i] ?? -1,
					condition: CONDITIONS[daily?.weather_code?.[i] ?? -1] ?? "unknown",
					temperature_max: daily?.temperature_2m_max?.[i] ?? null,
					temperature_min: daily?.temperature_2m_min?.[i] ?? null,
					// Every value is reported. Whether 10 percent is worth
					// mentioning aloud is the model's call, not ours.
					precipitation_probability:
						daily?.precipitation_probability_max?.[i] ?? null,
				})),
			};

			return JSON.stringify(result);
		},
	};
}
