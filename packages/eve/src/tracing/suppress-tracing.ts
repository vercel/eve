import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";

// Standard OpenTelemetry SDK suppression key, kept behind an eve-owned wrapper.
const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

export function suppressTracing(context: Context): Context {
  return context.setValue(SUPPRESS_TRACING_KEY, true);
}
