import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  routeProxiedDeliverStep,
  type RoutedDeliverResult,
} from "#execution/proxied-deliver-step.js";
import {
  emitRecordedTaskAuthorizationEventStep,
  emitRecordedTaskInputRequestStep,
} from "#execution/subagent-event-proxy-step.js";
import {
  acceptTaskAuthorizationEventStep,
  recordTerminalTaskViewsStep,
  recordTaskInputRequestStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";

/**
 * Coalesces inbound deliver payloads and routes any descendant-bound input
 * responses down to the owning child. A descendant session-limit Stop is
 * returned as parent-owned turn control after the child consumes the answer.
 *
 * Short-circuits via `hasProxyInputRequests` so the common no-active-descendant
 * path skips a durable step boundary. Lives in its own non-step module so both
 * the driver and the active turn can share it (a `"use step"` module cannot
 * re-export plain helpers into a workflow body).
 */
export async function routeDeliverToChildren(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly DeliverPayload[];
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}): Promise<RoutedDeliverResult> {
  let payload = coalesceDeliverPayloads(input.payloads);
  let serializedContext = input.serializedContext;
  let sessionState = input.sessionState;

  if ((payload.task?.views?.length ?? 0) > 0) {
    sessionState = await recordTerminalTaskViewsStep({
      sessionState,
      views: payload.task?.views ?? [],
    });
  }

  for (const request of payload.task?.inputRequests ?? []) {
    const recorded = await recordTaskInputRequestStep({
      hookPayload: request.hookPayload,
      serializedContext,
      sessionState,
      taskId: request.taskId,
    });
    sessionState = recorded.sessionState;
    if (!recorded.accepted) continue;
    const emitted = await emitRecordedTaskInputRequestStep({
      hookPayload: recorded.hookPayload,
      parentWritable: input.parentWritable,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  for (const request of payload.task?.authorizationEvents ?? []) {
    const accepted = await acceptTaskAuthorizationEventStep({
      hookPayload: request.hookPayload,
      sessionState,
      taskId: request.taskId,
    });
    if (!accepted) continue;
    const emitted = await emitRecordedTaskAuthorizationEventStep({
      hookPayload: request.hookPayload,
      parentWritable: input.parentWritable,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  if (payload.task !== undefined) {
    const ordinaryPayload = { ...payload };
    delete ordinaryPayload.task;
    payload = ordinaryPayload;
  }
  if (!sessionState.hasProxyInputRequests) {
    return {
      kind: "continue",
      remainder: Object.keys(payload).length === 0 ? undefined : payload,
      serializedContext,
      sessionState,
    };
  }

  return await routeProxiedDeliverStep({
    auth: input.auth,
    parentWritable: input.parentWritable,
    payload,
    serializedContext,
    sessionState,
  });
}
