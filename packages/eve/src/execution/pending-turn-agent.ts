import type { HookPayload } from "#channel/types.js";
import { PendingTurnAgentNodeIdKey } from "#context/keys.js";

/** Restores a selected turn agent for the response that settles its pending request. */
export function inheritPendingTurnAgent(
  delivery: HookPayload,
  serializedContext: Record<string, unknown>,
): HookPayload {
  if (
    delivery.kind !== "deliver" ||
    delivery.agentNodeId !== undefined ||
    delivery.payloads.some((payload) => payload.message !== undefined)
  ) {
    return delivery;
  }
  const pendingNodeId = serializedContext[PendingTurnAgentNodeIdKey.name];
  return typeof pendingNodeId === "string" ? { ...delivery, agentNodeId: pendingNodeId } : delivery;
}
