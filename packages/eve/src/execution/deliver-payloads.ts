import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

const COALESCED_DELIVER_FIELDS = ["context", "inputResponses", "message", "outputSchema"] as const;

/** Coalesces channel payloads while preserving turn input and adapter-specific fields. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    turnInput = coalesceTurnInputs(turnInput, payload);
  }

  for (const field of COALESCED_DELIVER_FIELDS) {
    delete merged[field];
  }

  return Object.assign(merged, turnInput);
}
