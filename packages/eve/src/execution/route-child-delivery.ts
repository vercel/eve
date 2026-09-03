import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  routeProxiedDeliverStep,
  type RoutedDeliverResult,
} from "#execution/proxied-deliver-step.js";
import {
  emitRecordedTaskInputRequestStep,
  runProxySubagentEventStep,
} from "#subagents/event-proxy-step.js";
import {
  recordTerminalTaskViewsStep,
  recordTaskInputRequestStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";
import { acceptTaskAuthorizationEventStep } from "#execution/tools/subagent/accept-event-step.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";

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

  for (const request of payload.task?.inputRequests ?? []) {
    const recorded = await recordTaskInputRequestStep({
      request,
      sessionState,
    });
    sessionState = recorded.sessionState;
    if (!recorded.accepted) continue;
    const emitted = await emitRecordedTaskInputRequestStep({
      parentWritable: input.parentWritable,
      request: recorded.request,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  for (const request of payload.task?.agentRequests ?? []) {
    const applied = await applyTaskAgentRequest(
      { ...request, ownerId: request.taskId },
      {
        parentWritable: input.parentWritable,
        serializedContext,
        sessionState,
      },
    );
    serializedContext = applied.serializedContext;
    sessionState = applied.sessionState;
  }

  // Authorization is display-only: the callback completes against the child,
  // so the parent re-emits the event without recording a proxy input request.
  for (const delivery of payload.task?.authorizationEvents ?? []) {
    const accepted = await acceptTaskAuthorizationEventStep({ delivery, sessionState });
    if (!accepted) continue;
    const emitted = await runProxySubagentEventStep({
      hookPayload: delivery.hookPayload,
      parentWritable: input.parentWritable,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  // Child settlement carries the authoritative parked/terminal handle verdict
  // and is enqueued before the task's terminal view. Preserve that ordering
  // when several task deliveries are coalesced into one parent turn.
  if ((payload.task?.views?.length ?? 0) > 0) {
    sessionState = await recordTerminalTaskViewsStep({
      sessionState,
      views: payload.task?.views ?? [],
    });
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
