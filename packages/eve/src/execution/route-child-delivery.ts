import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { suppressesTaskNotification } from "#harness/workflow-tool-runs.js";
import { formatTaskNotification } from "#tasks/notification.js";
import type { TaskView } from "#tasks/types.js";
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
 * the owner and the active turn can share it (a `"use step"` module cannot
 * re-export plain helpers into a workflow body).
 */
export async function routeDeliverToChildren(input: {
  readonly delivery: DeliverHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}): Promise<RoutedDeliverResult> {
  const payload = coalesceDeliverPayloads(input.delivery.payloads);
  let serializedContext = input.serializedContext;
  let sessionState = input.sessionState;
  const recordedTaskViews = new Map<string, TaskView>();
  // Coalescing can put an old request beside its outcome. Do not start new work
  // or display new questions for a task settling in this same delivery.
  const settlingTaskIds = new Set((payload.task?.views ?? []).map((view) => view.taskId));

  for (const request of payload.task?.inputRequests ?? []) {
    if (settlingTaskIds.has(request.taskId)) continue;
    const recorded = await recordTaskInputRequestStep({
      request,
      sessionState,
    });
    sessionState = recorded.sessionState;
    if (!recorded.accepted) continue;
    const emitted = await emitRecordedTaskInputRequestStep({
      sessionWritable: input.sessionWritable,
      request: recorded.request,
      serializedContext,
      sessionState,
    });
    serializedContext = emitted.serializedContext;
    sessionState = emitted.sessionState;
  }

  for (const request of payload.task?.agentRequests ?? []) {
    if (request.request.kind === "agent-invoke" && settlingTaskIds.has(request.taskId)) continue;
    const applied = await applyTaskAgentRequest(
      { ...request, ownerId: request.taskId },
      {
        sessionWritable: input.sessionWritable,
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
    if (
      delivery.hookPayload.event.type === "authorization.required" &&
      settlingTaskIds.has(delivery.taskId)
    )
      continue;
    const accepted = await acceptTaskAuthorizationEventStep({ delivery, sessionState });
    if (!accepted) continue;
    const emitted = await runProxySubagentEventStep({
      hookPayload: delivery.hookPayload,
      sessionWritable: input.sessionWritable,
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
    const recorded = await recordTerminalTaskViewsStep({
      serializedContext,
      sessionState,
      views: payload.task?.views ?? [],
    });
    serializedContext = recorded.serializedContext;
    sessionState = recorded.sessionState;
    for (const view of recorded.views) recordedTaskViews.set(view.taskId, view);
    // Publish after the durable write; replay retains these events, while duplicate deliveries return none.
    for (const event of recorded.subagentCompletions) {
      const emitted = await emitSubagentEventStep({
        event,
        sessionWritable: input.sessionWritable,
        serializedContext,
        sessionState,
      });
      serializedContext = emitted.serializedContext;
    }
  }

  // Settlement acknowledgements above still run. Only the model-facing delivery
  // is revoked when the owning session cancelled this task.
  if (
    suppressesTaskNotification(sessionState.snapshot.session.state, input.delivery.taskDeliveryId)
  ) {
    return { kind: "continue", remainder: undefined, serializedContext, sessionState };
  }

  const ordinaryPayloads: DeliverPayload[] = [];
  const ordinaryMetadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][] = [];
  for (const [sourcePayloadIndex, sourcePayload] of input.delivery.payloads.entries()) {
    const ordinaryPayload = { ...sourcePayload };
    delete ordinaryPayload.task;
    if (ordinaryPayload.message !== undefined && sourcePayload.task?.views !== undefined) {
      const notifications = sourcePayload.task.views.flatMap(({ taskId }) => {
        const view = recordedTaskViews.get(taskId);
        return view === undefined ? [] : [formatTaskNotification(view)];
      });
      if (notifications.length === 0) delete ordinaryPayload.message;
      else ordinaryPayload.message = notifications.join("\n\n");
    }
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
    sessionWritable: input.sessionWritable,
    serializedContext,
    sessionState,
  });
}
