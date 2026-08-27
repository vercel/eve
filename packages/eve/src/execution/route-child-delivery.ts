import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
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
  recordTaskInputRequestStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";
import { emitTaskViewDeliveriesStep } from "#execution/tasks/parent/client-events.js";

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
  readonly delivery: DeliverHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}): Promise<RoutedDeliverResult> {
  const payload = coalesceDeliverPayloads(input.delivery.payloads);
  let serializedContext = input.serializedContext;
  let sessionState = input.sessionState;

  const taskViewDeliveries = input.delivery.payloads.flatMap((sourcePayload) =>
    (sourcePayload.task?.views ?? []).map((view) => ({
      message: typeof sourcePayload.message === "string" ? sourcePayload.message : undefined,
      view,
    })),
  );
  if (taskViewDeliveries.length > 0) {
    const emitted = await emitTaskViewDeliveriesStep({
      deliveries: taskViewDeliveries,
      parentWritable: input.parentWritable,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
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

  const ordinaryPayloads: DeliverPayload[] = [];
  const ordinaryMetadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][] = [];
  for (const [sourcePayloadIndex, sourcePayload] of input.delivery.payloads.entries()) {
    const ordinaryPayload = { ...sourcePayload };
    delete ordinaryPayload.task;
    if (Object.keys(ordinaryPayload).length === 0) continue;
    const payloadIndex = ordinaryPayloads.length;
    ordinaryPayloads.push(ordinaryPayload);
    for (const metadata of input.delivery.deliveryMetadata ?? []) {
      if (metadata.payloadIndex === sourcePayloadIndex) {
        ordinaryMetadata.push({ ...metadata, payloadIndex });
      }
    }
  }
  const delivery: DeliverHookPayload | undefined =
    ordinaryPayloads.length === 0
      ? undefined
      : {
          ...input.delivery,
          deliveryMetadata: ordinaryMetadata.length === 0 ? undefined : ordinaryMetadata,
          payloads: ordinaryPayloads,
        };
  if (delivery === undefined) {
    return { kind: "continue", remainder: undefined, serializedContext, sessionState };
  }
  if (!sessionState.hasProxyInputRequests) {
    return {
      kind: "continue",
      remainder: delivery,
      serializedContext,
      sessionState,
    };
  }

  return await routeProxiedDeliverStep({
    delivery,
    parentWritable: input.parentWritable,
    serializedContext,
    sessionState,
  });
}
