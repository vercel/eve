import {
  context as otelContext,
  createContextKey,
  type Context,
} from "#compiled/@opentelemetry/api/index.js";

import type { JsonValue } from "#shared/json.js";

const INSTRUMENTATION_CLASSIFICATION_KEY = createContextKey("eve.instrumentation.classification");

export function instrumentationClassificationFromContext(context: unknown): JsonValue | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const getValue = Reflect.get(context, "getValue");
  return typeof getValue === "function"
    ? (Reflect.apply(getValue, context, [INSTRUMENTATION_CLASSIFICATION_KEY]) as
        | JsonValue
        | undefined)
    : undefined;
}

export function withInstrumentationClassification(
  context: Context,
  classification: JsonValue | undefined,
): Context {
  return classification === undefined
    ? context
    : context.setValue(INSTRUMENTATION_CLASSIFICATION_KEY, classification);
}

export function withActiveInstrumentationClassification(context: Context): Context {
  return withInstrumentationClassification(
    context,
    instrumentationClassificationFromContext(otelContext.active()),
  );
}

export function runWithInstrumentationClassification<T>(
  classification: JsonValue | undefined,
  execute: () => T,
): T {
  return otelContext.with(
    withInstrumentationClassification(otelContext.active(), classification),
    execute,
  );
}
