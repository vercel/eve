import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type Telemetry } from "ai";

let registered = false;
let eveOtelIntegration: Telemetry | undefined;

/**
 * Registers the AI SDK OpenTelemetry integration once so that model
 * calls emit OTel spans, including runtime-context attributes. Safe to
 * call multiple times — only the first call has an effect.
 *
 * In AI SDK v7 the built-in OTel tracing was moved to `@ai-sdk/otel`
 * and must be registered explicitly.
 */
export function ensureOtelIntegration(): void {
  if (registered) {
    return;
  }
  registered = true;
  eveOtelIntegration = new OpenTelemetry({ runtimeContext: true });
  registerTelemetry(eveOtelIntegration);
}

/**
 * Every integration currently registered with the AI SDK — eve's own, plus any
 * an authored instrumentation module added with `registerTelemetry`.
 *
 * A per-call `integrations` list replaces the registered ones rather than
 * adding to them, so anything that passes integrations per call has to carry
 * these forward or they stop receiving events.
 */
export function getRegisteredTelemetryIntegrations(options?: {
  readonly includeEveOtel?: boolean;
}): readonly Telemetry[] {
  const integrations = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
  return options?.includeEveOtel === false
    ? integrations.filter((integration) => integration !== eveOtelIntegration)
    : integrations;
}
