import type { ChannelDeliveryDecision, ChannelDeliveryResult } from "#channel/adapter.js";
import type { StepInput } from "#harness/types.js";

/** Internal normalized result from one channel adapter delivery. */
export type NormalizedChannelDeliveryDecision =
  | { readonly action: "defer"; readonly input: StepInput; readonly reason?: string }
  | { readonly action: "drop"; readonly reason?: string }
  | { readonly action: "dispatch"; readonly input: StepInput };

/** Normalizes the legacy StepInput/void adapter contract into explicit control actions. */
export function normalizeChannelDeliveryDecision(
  result: ChannelDeliveryResult,
): NormalizedChannelDeliveryDecision {
  if (result === undefined || result === null) return { action: "drop" };
  if (isChannelDeliveryDecision(result)) return result;
  return { action: "dispatch", input: result };
}

function isChannelDeliveryDecision(value: unknown): value is ChannelDeliveryDecision {
  if (typeof value !== "object" || value === null || !("action" in value)) return false;
  const action = (value as { readonly action?: unknown }).action;
  return action === "defer" || action === "dispatch" || action === "drop";
}
