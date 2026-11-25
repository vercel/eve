import type { Configuration } from "#tracing/eve/otel-configuration.js";

export function registerOTel(_configuration: Configuration): void {}

export function tryLoadExternalOtelApi(): typeof import("@opentelemetry/api") | undefined {
  return undefined;
}
