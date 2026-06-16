import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry } from "ai";

let registered = false;

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
  registerTelemetry(
    new OpenTelemetry({
      runtimeContext: true,
    }),
  );
}
