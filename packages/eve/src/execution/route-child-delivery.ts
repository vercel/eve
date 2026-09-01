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
  acceptTaskAgentEventStep,
  recordTerminalTaskViewsStep,
  recordTaskInputRequestStep,
} from "#execution/task-hitl-proxy-steps.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invocation-step.js";
import {
  isAgentInvocationRequest,
  type AgentInvocationRequest,
} from "#execution/tools/subagent/invocation.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { TaskEffectDelivery } from "#tasks/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { emitTaskSubagentCalledStep } from "#execution/tools/subagent/emit-called-step.js";

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
  readonly callbackBaseUrl?: string;
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

  for (const effect of payload.task?.effects ?? []) {
    if (isSubagentCalledEffect(effect)) {
      const emitted = await emitTaskSubagentCalledStep({
        event: effect.input,
        parentWritable: input.parentWritable,
        serializedContext,
      });
      serializedContext = emitted.serializedContext;
      continue;
    }
    const settlement = readAgentSettlement(effect);
    if (settlement !== undefined) {
      const settled = await settleTaskAgentInvocationStep({
        result: settlement,
        sessionState,
        taskId: effect.taskId,
      });
      sessionState = settled.sessionState;
      continue;
    }
    const invocation = readAgentInvocation(effect);
    if (invocation !== undefined) {
      const dispatched = await dispatchTaskAgentInvocationStep({
        callbackBaseUrl: input.callbackBaseUrl,
        replyTo: effect.replyTo,
        request: invocation,
        serializedContext,
        sessionState,
        taskId: effect.taskId,
      });
      sessionState = dispatched.sessionState;
      if (dispatched.accepted && dispatched.calledEvent !== undefined) {
        const emitted = await emitTaskSubagentCalledStep({
          event: dispatched.calledEvent,
          parentWritable: input.parentWritable,
          serializedContext,
        });
        serializedContext = emitted.serializedContext;
      }
      if (dispatched.accepted && dispatched.result !== undefined) {
        await resumeHookStep(effect.replyTo, {
          kind: "runtime-action-result",
          results: [dispatched.result],
        });
      }
      continue;
    }

    const accepted = await acceptTaskAgentEventStep({
      effect,
      sessionState,
    });
    if (!accepted.accepted) continue;
    const emitted = await runProxySubagentEventStep({
      hookPayload: accepted.hookPayload,
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

function isSubagentCalledEffect(effect: TaskEffectDelivery): effect is TaskEffectDelivery & {
  readonly input: Extract<
    import("#protocol/message.js").UnstampedMessageStreamEvent,
    { type: "subagent.called" }
  >;
} {
  return (
    effect.name === "agent.called" &&
    typeof effect.input === "object" &&
    effect.input !== null &&
    !Array.isArray(effect.input) &&
    Reflect.get(effect.input, "type") === "subagent.called"
  );
}

function readAgentSettlement(effect: TaskEffectDelivery): RuntimeSubagentChildResult | undefined {
  if (effect.name !== "agent.settled") return undefined;
  const result = effect.input as RuntimeSubagentChildResult;
  return result.kind === "subagent-result" && result.origin === "child" ? result : undefined;
}

function readAgentInvocation(effect: TaskEffectDelivery): AgentInvocationRequest | undefined {
  const request = {
    input: effect.input,
    invocationId: effect.invocationId,
    kind: "effect" as const,
    name: effect.name,
  };
  return isAgentInvocationRequest(request) ? request : undefined;
}
