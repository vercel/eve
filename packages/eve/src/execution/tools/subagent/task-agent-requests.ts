import type { DurableSessionState } from "#execution/durable-session-store.js";
import { emitTaskSubagentCalledStep } from "#execution/tools/subagent/emit-called-step.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { TaskAgentRequestDelivery } from "#tasks/types.js";

export interface AgentRequestDelivery {
  readonly accumulateUsage?: boolean;
  readonly actionCallId?: string;
  readonly ownerId: string;
  readonly replyTo: TaskAgentRequestDelivery["replyTo"];
  readonly request: TaskAgentRequestDelivery["request"];
  readonly taskId?: string;
}

export interface TaskAgentRequestContext {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export interface AppliedTaskAgentRequest {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Applies one workflow-owned agent request to the parent session: `agent-invoke`
 * spawns the child with parent-owned material and `agent-settled` releases the
 * handle. Child authorization and HITL ride their own task envelope arms.
 */
export async function applyTaskAgentRequest(
  delivery: AgentRequestDelivery,
  ctx: TaskAgentRequestContext,
): Promise<AppliedTaskAgentRequest> {
  const { request } = delivery;
  switch (request.kind) {
    case "agent-settled": {
      const settled = await settleTaskAgentInvocationStep({
        accumulateUsage: delivery.accumulateUsage,
        ownerId: delivery.ownerId,
        result: request.result,
        serializedContext: ctx.serializedContext,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      return settled;
    }
    case "agent-invoke": {
      const dispatched = await dispatchTaskAgentInvocationStep({
        actionCallId: delivery.actionCallId,
        ownerId: delivery.ownerId,
        replyTo: delivery.replyTo,
        request,
        serializedContext: ctx.serializedContext,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      switch (dispatched.kind) {
        case "dispatched": {
          const emitted = await emitTaskSubagentCalledStep({
            event: dispatched.event,
            parentWritable: ctx.parentWritable,
            serializedContext: dispatched.serializedContext,
          });
          return {
            serializedContext: emitted.serializedContext,
            sessionState: dispatched.sessionState,
          };
        }
        case "failed":
          await resumeHookStep(delivery.replyTo, {
            kind: "runtime-action-result",
            results: [dispatched.result],
          });
          return {
            serializedContext: dispatched.serializedContext,
            sessionState: dispatched.sessionState,
          };
        case "not-admitted":
          return {
            serializedContext: ctx.serializedContext,
            sessionState: dispatched.sessionState,
          };
      }
    }
  }
}
