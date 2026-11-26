import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";
import type { JsonObject } from "#shared/json.js";

function digest(value: Parameters<typeof canonicalJson>[0]): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function channelSubscriptionId(input: {
  readonly channelName: string;
  readonly key: string;
  readonly sessionId: string;
  readonly executionPrincipal: string;
}): string {
  return digest([input.channelName, input.key, input.sessionId, input.executionPrincipal]);
}

export function connectionSubscriptionId(input: {
  readonly sessionId: string;
  readonly instanceId: string | undefined;
  readonly connectionName: string;
  readonly owner: string;
  readonly executionPrincipal: string;
  readonly event: string;
  readonly arguments: JsonObject;
}): string {
  return digest([
    input.sessionId,
    input.instanceId ?? null,
    input.connectionName,
    input.owner,
    input.executionPrincipal,
    input.event,
    input.arguments,
  ]);
}

export function channelEventKey(event: string, input: JsonObject): string {
  return digest([event, input]);
}

export function openIdempotencyKey(bindingId: string, ownerRunId: string): string {
  return digest([bindingId, ownerRunId]);
}

export function deliveryIdempotencyKey(bindingId: string, eventId: string): string {
  return `eve:subscription:${digest([bindingId, eventId])}`;
}
