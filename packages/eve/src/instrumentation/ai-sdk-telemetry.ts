import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type Telemetry } from "ai";
import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.ai-sdk-telemetry");
let registered = false;
let eveOtelIntegration: Telemetry | undefined;
let errorSafeEveOtelIntegration: Telemetry | undefined;
let warnedMissingEveOtelIntegration = false;

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
  errorSafeEveOtelIntegration = telemetryWithoutErrorContent(eveOtelIntegration);
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
  readonly excludeEveOtelIntegration?: boolean;
  readonly sanitizeEveOtelErrors?: boolean;
}): readonly Telemetry[] {
  const registered = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
  const integrations =
    options?.excludeEveOtelIntegration === true
      ? registered.filter((integration) => integration !== eveOtelIntegration)
      : registered;
  if (options?.sanitizeEveOtelErrors !== true) return integrations;
  let matched = false;
  const sanitized = integrations.map((integration) => {
    if (integration !== eveOtelIntegration || errorSafeEveOtelIntegration === undefined) {
      return integration;
    }
    matched = true;
    return errorSafeEveOtelIntegration;
  });
  if (!matched && options.excludeEveOtelIntegration !== true && !warnedMissingEveOtelIntegration) {
    warnedMissingEveOtelIntegration = true;
    log.warn("could not sanitize eve's AI SDK OpenTelemetry integration", {
      reason:
        eveOtelIntegration === undefined
          ? "eve OpenTelemetry integration was not registered"
          : "registered integration identity did not match",
    });
  }
  return sanitized;
}

/** @internal */
export function telemetryWithoutErrorContent(integration: Telemetry): Telemetry {
  const genericError = (): Error => new Error("AI SDK operation failed");
  return new Proxy(integration, {
    get(target, property) {
      if (property === "onError" && target.onError !== undefined) {
        return (event: unknown) =>
          target.onError!(
            typeof event === "object" && event !== null
              ? { ...event, error: genericError() }
              : genericError(),
          );
      }
      if (property === "onToolExecutionEnd" && target.onToolExecutionEnd !== undefined) {
        return (event: Parameters<NonNullable<Telemetry["onToolExecutionEnd"]>>[0]) =>
          target.onToolExecutionEnd!(
            event.toolOutput.type === "tool-error"
              ? { ...event, toolOutput: { ...event.toolOutput, error: genericError() } }
              : event,
          );
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
