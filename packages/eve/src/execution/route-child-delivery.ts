import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  routeProxiedDeliverStep,
  type RoutedDeliverResult,
} from "#execution/proxied-deliver-step.js";

/**
 * Routes any descendant-bound input responses down to the owning child. A
 * descendant session-limit Stop is returned as parent-owned turn control after
 * the child consumes the answer.
 *
 * Short-circuits via `hasProxyInputRequests` so the common no-active-descendant
 * path skips a durable step boundary. Lives in its own non-step module so both
 * the owner and the active turn can share it (a `"use step"` module cannot
 * re-export plain helpers into a workflow body).
 */
export async function routeDeliverToChildren(input: {
  readonly delivery: DeliverHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}): Promise<RoutedDeliverResult> {
  if (!input.sessionState.hasProxyInputRequests) {
    return {
      kind: "continue",
      remainder: input.delivery,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  return await routeProxiedDeliverStep(input);
}
