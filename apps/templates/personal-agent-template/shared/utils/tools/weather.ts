import type { DynamicToolUIPart } from "ai";
import type { WeatherOutput } from "~~/shared/tools/weather";

export type WeatherUIToolInvocation = DynamicToolUIPart & {
  output: WeatherOutput;
};
