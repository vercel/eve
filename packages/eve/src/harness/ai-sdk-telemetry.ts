import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type Telemetry } from "ai";

let registered = false;
let eveOtelIntegration: Telemetry | undefined;
let errorSafeEveOtelIntegration: Telemetry | undefined;

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
  readonly sanitizeEveOtelErrors?: boolean;
}): readonly Telemetry[] {
  const integrations = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
  return options?.sanitizeEveOtelErrors === true
    ? integrations.map((integration) =>
        integration === eveOtelIntegration && errorSafeEveOtelIntegration !== undefined
          ? errorSafeEveOtelIntegration
          : integration,
      )
    : integrations;
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
