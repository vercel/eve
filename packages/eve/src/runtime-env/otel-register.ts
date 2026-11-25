import { createRequire } from "node:module";

import { registerOTel as registerVercelOtel } from "#compiled/@vercel/otel/index.js";
import type { Configuration } from "#tracing/eve/otel-configuration.js";

export function registerOTel(configuration: Configuration): void {
  registerVercelOtel(configuration);
}

export function tryLoadExternalOtelApi(): typeof import("@opentelemetry/api") | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  } catch {
    return undefined;
  }
}
