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
  recordTerminalTaskSnapshotsStep,
  recordTaskInputRequestStep,
} from "#execution/tasks/hitl-proxy-steps.js";

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

  if ((payload.taskSnapshots?.length ?? 0) > 0) {
    sessionState = await recordTerminalTaskSnapshotsStep({
      sessionState,
      snapshots: payload.taskSnapshots ?? [],
    });
  }

  for (const request of payload.taskInputRequests ?? []) {
    const recorded = await recordTaskInputRequestStep({
      hookPayload: request.hookPayload,
      serializedContext,
      sessionState,
      taskId: request.taskId,
    });
    sessionState = recorded.sessionState;
    if (!recorded.accepted) continue;
    const emitted = await emitRecordedTaskInputRequestStep({
      hookPayload: request.hookPayload,
      parentWritable: input.parentWritable,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  for (const request of payload.taskAuthorizationEvents ?? []) {
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

  if (payload.taskInputRequests !== undefined) {
    const ordinaryPayload = { ...payload };
    delete ordinaryPayload.taskInputRequests;
    payload = ordinaryPayload;
  }
  if (payload.taskAuthorizationEvents !== undefined) {
    const ordinaryPayload = { ...payload };
    delete ordinaryPayload.taskAuthorizationEvents;
    payload = ordinaryPayload;
  }
  if (payload.taskSnapshots !== undefined) {
    const ordinaryPayload = { ...payload };
    delete ordinaryPayload.taskSnapshots;
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
