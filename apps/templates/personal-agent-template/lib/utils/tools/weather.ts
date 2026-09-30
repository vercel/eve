import type { DynamicToolUIPart } from "ai";
import type { WeatherOutput } from "../../tools/weather";

export type WeatherUIToolInvocation = DynamicToolUIPart & {
  output: WeatherOutput;
};
