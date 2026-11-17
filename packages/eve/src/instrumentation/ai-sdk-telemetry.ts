import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type Telemetry } from "ai";
import type { InstrumentationHooks } from "#instrumentation/lifecycle.js";
import { createLogger } from "#internal/logging.js";

interface ContentCapture {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

export function aiSdkCapture(
  content: ContentCapture,
  hooks: Pick<InstrumentationHooks, "authoredCapturesInputs" | "authoredCapturesOutputs">,
): ContentCapture {
  return {
    recordInputs: content.recordInputs || hooks.authoredCapturesInputs === true,
    recordOutputs: content.recordOutputs || hooks.authoredCapturesOutputs === true,
  };
}

const log = createLogger("harness.ai-sdk-telemetry");
let registered = false;
let eveOtelIntegration: Telemetry | undefined;
let errorSafeEveOtelIntegration: Telemetry | undefined;
let warnedMissingEveOtelIntegration = false;

export function ensureOtelIntegration(): void {
  if (registered) {
    return;
  }
  registered = true;
  eveOtelIntegration = new OpenTelemetry({ runtimeContext: true });
  errorSafeEveOtelIntegration = telemetryWithoutErrorContent(eveOtelIntegration);
  registerTelemetry(eveOtelIntegration);
}

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
