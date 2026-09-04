import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

const COALESCED_DELIVER_FIELDS = [
  "context",
  "inputResponses",
  "message",
  "observe",
  "outputSchema",
  "task",
] as const;

/** Observed payloads a parked or active session keeps before dropping the oldest. */
const OBSERVED_PAYLOAD_BUFFER_LIMIT = 256;

type TaskEnvelope = NonNullable<DeliverPayload["task"]>;

/** Coalesces channel payloads while preserving turn input and adapter-specific fields. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  const inputRequests: NonNullable<TaskEnvelope["inputRequests"]>[number][] = [];
  const agentRequests: NonNullable<TaskEnvelope["agentRequests"]>[number][] = [];
  const authorizationEvents: NonNullable<TaskEnvelope["authorizationEvents"]>[number][] = [];
  const views: NonNullable<TaskEnvelope["views"]>[number][] = [];
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    inputRequests.push(...(payload.task?.inputRequests ?? []));
    agentRequests.push(...(payload.task?.agentRequests ?? []));
    authorizationEvents.push(...(payload.task?.authorizationEvents ?? []));
    views.push(...(payload.task?.views ?? []));
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

  const task: Record<string, unknown> = {};
  if (inputRequests.length > 0) task.inputRequests = inputRequests;
  if (agentRequests.length > 0) task.agentRequests = agentRequests;
  if (authorizationEvents.length > 0) task.authorizationEvents = authorizationEvents;
  if (views.length > 0) task.views = views;
  if (Object.keys(task).length > 0) merged.task = task;
  if (payloads.every((payload) => payload.observe === true)) merged.observe = true;

  return Object.assign(merged, turnInput);
}

/** True when every payload in the delivery is history-only. */
export function isObserveOnlyDelivery(delivery: DeliverHookPayload): boolean {
  return (
    delivery.payloads.length > 0 && delivery.payloads.every((payload) => payload.observe === true)
  );
}

/** True when at least one buffered delivery should run a turn. */
export function hasAddressedDelivery(deliveries: readonly DeliverHookPayload[]): boolean {
  return deliveries.some((delivery) => !isObserveOnlyDelivery(delivery));
}

/**
 * Buffers an observe-only delivery without waking the session. Returns `false`
 * for deliveries that should run a turn so the caller handles them as before.
 * The observed backlog is capped; the oldest observed deliveries drop first.
 */
export function bufferObservedDelivery(
  buffer: DeliverHookPayload[],
  delivery: DeliverHookPayload,
): boolean {
  if (!isObserveOnlyDelivery(delivery)) return false;
  buffer.push(delivery);

  let excess =
    buffer.reduce(
      (count, entry) => count + (isObserveOnlyDelivery(entry) ? entry.payloads.length : 0),
      0,
    ) - OBSERVED_PAYLOAD_BUFFER_LIMIT;
  while (excess > 0) {
    const oldest = buffer.findIndex(isObserveOnlyDelivery);
    if (oldest < 0) break;
    const [dropped] = buffer.splice(oldest, 1);
    excess -= dropped?.payloads.length ?? 0;
  }
  return true;
}
