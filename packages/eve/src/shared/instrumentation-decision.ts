import { CHANNEL_AUDIENCES, type ChannelAudience } from "#shared/channel-audience.js";

export type InstrumentationDecision =
  | { readonly action: "drop" }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
      /** The audience for which an explicit policy authorized content. */
      readonly explicitContentAudience?: ChannelAudience;
    };

export const DROP_INSTRUMENTATION: InstrumentationDecision = { action: "drop" };

/** Reads durable decision state, treating malformed persisted values as drop. */
export function readInstrumentationDecision(value: unknown): InstrumentationDecision | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DROP_INSTRUMENTATION;
  }
  const decision = value as Partial<InstrumentationDecision>;
  if (decision.action === "drop") return DROP_INSTRUMENTATION;
  return decision.action === "record" &&
    typeof decision.recordInputs === "boolean" &&
    typeof decision.recordOutputs === "boolean"
    ? {
        action: "record",
        recordInputs: decision.recordInputs,
        recordOutputs: decision.recordOutputs,
        ...(decision.explicitContentAudience !== undefined &&
        CHANNEL_AUDIENCES.includes(decision.explicitContentAudience)
          ? { explicitContentAudience: decision.explicitContentAudience }
          : undefined),
      }
    : DROP_INSTRUMENTATION;
}

export function intersectInstrumentationDecisions(
  left: InstrumentationDecision,
  right: InstrumentationDecision,
): InstrumentationDecision {
  if (left.action === "drop" || right.action === "drop") return DROP_INSTRUMENTATION;
  const explicitContentAudience =
    left.explicitContentAudience === undefined
      ? right.explicitContentAudience
      : right.explicitContentAudience === undefined ||
          left.explicitContentAudience === right.explicitContentAudience
        ? left.explicitContentAudience
        : undefined;
  return {
    action: "record",
    recordInputs: left.recordInputs && right.recordInputs,
    recordOutputs: left.recordOutputs && right.recordOutputs,
    ...(explicitContentAudience !== undefined ? { explicitContentAudience } : undefined),
  };
}
