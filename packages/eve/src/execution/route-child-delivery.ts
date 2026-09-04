import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { DurableSessionState } from "#execution/session/state.js";
import { routeProxiedDelivery, type RoutedDeliverResult } from "#execution/turn/proxy-delivery.js";
import {
  emitRecordedTaskInputRequest,
  runProxySubagentEvent,
} from "#subagents/event-proxy-step.js";
import { recordTerminalTaskViews, recordTaskInputRequest } from "#execution/tasks/input.js";
import { acceptTaskAuthorizationEvent } from "#execution/tools/subagent/accept-event-step.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";

/** Routes descendant-bound responses and returns the remaining session input. */
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
    const recorded = await recordTaskInputRequest({
      request,
      sessionState,
    });
    sessionState = recorded.sessionState;
    if (!recorded.accepted) continue;
    const emitted = await emitRecordedTaskInputRequest({
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
    const accepted = await acceptTaskAuthorizationEvent({ delivery, sessionState });
    if (!accepted) continue;
    const emitted = await runProxySubagentEvent({
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
    sessionState = await recordTerminalTaskViews({
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

  return await routeProxiedDelivery({
    delivery,
    serializedContext,
    sessionState,
  });
}
