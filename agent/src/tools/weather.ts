/**
 * Daily forecast, from Open-Meteo.
 *
 * The first tool, and deliberately the dullest one that is still genuinely
 * useful: no API key, no account, no secret to manage, so it stays true to the
 * zero-dependency shape of the rest of the server. It is a prototype for the
 * tool-calling path more than it is a weather feature.
 *
 * Everything it returns is written to be SPOKEN. Barnaby reads answers aloud,
 * so the result text carries no symbols, no ranges in slashes, and no decimal
 * places nobody says out loud.
 */

import type { Tool } from "./types.ts";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO weather codes, as spoken phrases.
 *
 * Open-Meteo returns a bare integer. Handing "code 51" to the model invites it
 * to guess, and it guesses plausibly and wrongly, so the mapping lives here
 * where it can be checked rather than in the model's head.
 */
const CONDITIONS: Record<number, string> = {
	0: "clear",
	1: "mostly clear",
	2: "partly cloudy",
	3: "overcast",
	45: "foggy",
	48: "freezing fog",
	51: "light drizzle",
	53: "drizzle",
	55: "heavy drizzle",
	56: "freezing drizzle",
	57: "heavy freezing drizzle",
	61: "light rain",
	63: "rain",
	65: "heavy rain",
	66: "freezing rain",
	67: "heavy freezing rain",
	71: "light snow",
	73: "snow",
	75: "heavy snow",
	77: "snow grains",
	80: "light showers",
	81: "showers",
	82: "violent showers",
	85: "light snow showers",
	86: "heavy snow showers",
	95: "thunderstorms",
	96: "thunderstorms with hail",
	99: "thunderstorms with heavy hail",
};

function condition(code: number): string {
	return CONDITIONS[code] ?? "unsettled";
}

/** "2026-08-23" -> "Sunday". The model gets names, not ISO dates, because a
 * date said aloud is a name. */
function dayName(iso: string, todayIso: string, tomorrowIso: string): string {
	if (iso === todayIso) return "Today";
	if (iso === tomorrowIso) return "Tomorrow";
	const [y, m, d] = iso.split("-").map(Number);
	if (y === undefined || m === undefined || d === undefined) return iso;
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
		weekday: "long",
		timeZone: "UTC",
	});
}

interface Forecast {
	daily?: {
		time?: string[];
		weather_code?: number[];
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		precipitation_probability_max?: number[];
	};
}

export interface WeatherConfig {
	/** Default when the model does not say. Everything else comes per call. */
	unit: "fahrenheit" | "celsius";
}

export function weatherTool(cfg: WeatherConfig): Tool {
	return {
		name: "get_forecast",
		// Written for the model's benefit: it needs to know WHEN to reach for
		// this, and that it covers today as well as later days — otherwise
		// "is it hot out?" does not look like a forecast question.
		description:
			"Get the daily weather forecast — conditions, high and low temperature, " +
			"and chance of rain — for the next few days at a location. Use this for " +
			"any question about weather, temperature, rain, snow, or what to wear, " +
			"whether it is about today, tomorrow, or later this week. Pass the " +
			"coordinates of the household's home unless another place is named.",
		parameters: {
			type: "object",
			properties: {
				// The model fills these from its own context, where CONTEXT.md
				// has put the household's coordinates. Measured 12/12 exact, so
				// there is no second copy of the location to drift out of step.
				latitude: {
					type: "number",
					description: "Latitude of the place being asked about.",
				},
				longitude: {
					type: "number",
					description: "Longitude of the place being asked about.",
				},
				place: {
					type: "string",
					description:
						"What to call this place when speaking, for example the town name.",
				},
				days: {
					type: "integer",
					description:
						"How many days to fetch, starting today. Use 1 for today only, " +
						"2 to include tomorrow, up to 7. Defaults to 3.",
					minimum: 1,
					maximum: 7,
				},
			},
			required: ["latitude", "longitude"],
		},
		readOnly: true,

		async run(args, signal): Promise<string> {
			// Everything here comes from the model, so nothing is trusted.
			// Coordinates out of range mean it invented them; better to say so
			// than to forecast the Gulf of Guinea.
			const latitude = Number(args.latitude);
			const longitude = Number(args.longitude);
			if (
				!Number.isFinite(latitude) ||
				!Number.isFinite(longitude) ||
				Math.abs(latitude) > 90 ||
				Math.abs(longitude) > 180
			) {
				throw new Error(
					"no valid coordinates were given for the place to forecast",
				);
			}
			const place =
				typeof args.place === "string" && args.place.trim() !== ""
					? args.place.trim()
					: "there";

			const raw = Number(args.days);
			const days = Number.isFinite(raw)
				? Math.min(Math.max(Math.trunc(raw), 1), 7)
				: 3;

			const url =
				`${ENDPOINT}?latitude=${latitude}&longitude=${longitude}` +
				"&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
				`&temperature_unit=${cfg.unit}&timezone=auto&forecast_days=${days}`;

			const response = await fetch(url, { signal });
			if (!response.ok) {
				throw new Error(`weather service returned ${response.status}`);
			}
			const data = (await response.json()) as Forecast;
			const daily = data.daily;
			const times = daily?.time ?? [];
			if (times.length === 0)
				throw new Error("weather service returned no forecast");

			// "Today" and "tomorrow" are resolved against the forecast's own
			// first day, which Open-Meteo returns in the location's timezone.
			// Using the server's clock would be wrong across midnight.
			const todayIso = times[0] ?? "";
			const tomorrowIso = times[1] ?? "";
			const degrees = cfg.unit === "fahrenheit" ? "F" : "C";

			const lines = times.map((iso, i) => {
				const code = daily?.weather_code?.[i];
				const high = daily?.temperature_2m_max?.[i];
				const low = daily?.temperature_2m_min?.[i];
				const rain = daily?.precipitation_probability_max?.[i];
				const parts = [`${dayName(iso, todayIso, tomorrowIso)}:`];
				if (code !== undefined) parts.push(`${condition(code)},`);
				if (high !== undefined)
					parts.push(`high ${Math.round(high)} degrees ${degrees},`);
				if (low !== undefined) parts.push(`low ${Math.round(low)},`);
				// Below about a fifth it is not worth saying, and Barnaby
				// mentioning a 2% chance of rain every morning would grate.
				if (rain !== undefined && rain >= 20)
					parts.push(`${rain} percent chance of rain,`);
				return parts.join(" ").replace(/,$/, "");
			});

			return `Forecast for ${place}:\n${lines.join("\n")}`;
		},
	};
}
