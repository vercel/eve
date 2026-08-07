import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

const COALESCED_DELIVER_FIELDS = [
  "context",
  "inputResponses",
  "message",
  "outputSchema",
  "taskInputRequests",
  "taskAuthorizationEvents",
  "taskSnapshots",
] as const;

/** Coalesces channel payloads while preserving turn input and adapter-specific fields. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  const taskInputRequests: NonNullable<DeliverPayload["taskInputRequests"]>[number][] = [];
  const taskAuthorizationEvents: NonNullable<DeliverPayload["taskAuthorizationEvents"]>[number][] =
    [];
  const taskSnapshots: NonNullable<DeliverPayload["taskSnapshots"]>[number][] = [];
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    taskInputRequests.push(...(payload.taskInputRequests ?? []));
    taskAuthorizationEvents.push(...(payload.taskAuthorizationEvents ?? []));
    taskSnapshots.push(...(payload.taskSnapshots ?? []));
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

  if (taskInputRequests.length > 0) merged.taskInputRequests = taskInputRequests;
  if (taskAuthorizationEvents.length > 0) {
    merged.taskAuthorizationEvents = taskAuthorizationEvents;
  }
  if (taskSnapshots.length > 0) merged.taskSnapshots = taskSnapshots;

  return Object.assign(merged, turnInput);
}
