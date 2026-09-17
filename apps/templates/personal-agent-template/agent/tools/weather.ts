import { defineTool } from "eve/tools";
import { z } from "zod";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
  };
}

const WEATHER_CODES: Record<number, { text: string; icon: string }> = {
  0: { text: "Clear sky", icon: "sun" },
  1: { text: "Mainly clear", icon: "sun" },
  2: { text: "Partly cloudy", icon: "cloud-sun" },
  3: { text: "Overcast", icon: "cloud" },
  45: { text: "Foggy", icon: "cloud-fog" },
  48: { text: "Foggy", icon: "cloud-fog" },
  51: { text: "Light drizzle", icon: "cloud-drizzle" },
  61: { text: "Rain", icon: "cloud-rain" },
  71: { text: "Snow", icon: "cloud-snow" },
  80: { text: "Rain showers", icon: "cloud-rain" },
  95: { text: "Thunderstorm", icon: "cloud-lightning" },
};

function conditionFromCode(code?: number) {
  return WEATHER_CODES[code ?? 0] ?? { text: "Unknown", icon: "cloud" };
}

async function geocode(location: string) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Geocoding failed");
  }

  const data = (await response.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number }>;
  };
  const result = data.results?.[0];
  if (!result) {
    throw new Error(`Could not find location: ${location}`);
  }

  return result;
}

export default defineTool({
  description: "Get current weather and a short forecast for a location",
  inputSchema: z.object({
    location: z.string().describe("City or place name"),
  }),
  outputSchema: z.object({
    location: z.string(),
    temperature: z.number(),
    temperatureHigh: z.number(),
    temperatureLow: z.number(),
    condition: z.object({
      text: z.string(),
      icon: z.string(),
    }),
    humidity: z.number(),
    windSpeed: z.number(),
    dailyForecast: z.array(
      z.object({
        day: z.string(),
        high: z.number(),
        low: z.number(),
        condition: z.object({
          text: z.string(),
          icon: z.string(),
        }),
      }),
    ),
  }),
  async execute({ location }) {
    const place = await geocode(location);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    );
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "5");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Weather lookup failed");
    }

    const data = (await response.json()) as OpenMeteoResponse;
    const currentCode = data.current?.weather_code;
    const currentCondition = conditionFromCode(currentCode);
    const label = place.name;

    const dailyForecast = (data.daily?.time ?? []).slice(0, 5).map((day, index) => {
      const code = data.daily?.weather_code?.[index];
      const condition = conditionFromCode(code);
      return {
        day,
        high: Math.round(data.daily?.temperature_2m_max?.[index] ?? 0),
        low: Math.round(data.daily?.temperature_2m_min?.[index] ?? 0),
        condition,
      };
    });

    const today = dailyForecast[0];

    return {
      location: label,
      temperature: Math.round(data.current?.temperature_2m ?? today?.high ?? 0),
      temperatureHigh: today?.high ?? Math.round(data.current?.temperature_2m ?? 0),
      temperatureLow: today?.low ?? Math.round(data.current?.temperature_2m ?? 0),
      condition: currentCondition,
      humidity: Math.round(data.current?.relative_humidity_2m ?? 0),
      windSpeed: Math.round(data.current?.wind_speed_10m ?? 0),
      dailyForecast,
    };
  },
});
