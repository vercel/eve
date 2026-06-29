import type { DeliverPayload } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";

/** Coalesces channel payloads while preserving every structured input response. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  const inputResponses: InputResponse[] = [];

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (key !== "inputResponses" && value !== undefined) {
        merged[key] = value;
      }
    }
    if (payload.inputResponses !== undefined) {
      inputResponses.push(...payload.inputResponses);
    }
  }

  if (inputResponses.length > 0) merged.inputResponses = inputResponses;
  return merged as DeliverPayload;
}
