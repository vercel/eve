import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";

const NATIVE_SAMPLING_DECISION_KEY = createContextKey("eve.native.sampling-decision");

export function nativeSamplingDecision(context: unknown): boolean | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const getValue = Reflect.get(context, "getValue");
  if (typeof getValue !== "function") return undefined;
  const value = Reflect.apply(getValue, context, [NATIVE_SAMPLING_DECISION_KEY]);
  return typeof value === "boolean" ? value : undefined;
}

export function withNativeSamplingDecision(context: Context, sampled: boolean): Context {
  return context.setValue(NATIVE_SAMPLING_DECISION_KEY, sampled);
}
