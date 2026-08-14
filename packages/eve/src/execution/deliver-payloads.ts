import type { DeliverPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

const COALESCED_DELIVER_FIELDS = [
  "clientMessageIds",
  "context",
  "inputResponses",
  "message",
  "outputSchema",
  "task",
] as const;

type TaskEnvelope = NonNullable<DeliverPayload["task"]>;

/** Coalesces channel payloads while preserving turn input and adapter-specific fields. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  const inputRequests: NonNullable<TaskEnvelope["inputRequests"]>[number][] = [];
  const authorizationEvents: NonNullable<TaskEnvelope["authorizationEvents"]>[number][] = [];
  const views: NonNullable<TaskEnvelope["views"]>[number][] = [];
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    inputRequests.push(...(payload.task?.inputRequests ?? []));
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
  if (authorizationEvents.length > 0) task.authorizationEvents = authorizationEvents;
  if (views.length > 0) task.views = views;
  if (Object.keys(task).length > 0) merged.task = task;

  return Object.assign(merged, turnInput);
}
