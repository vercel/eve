import type { DurableSessionState } from "#execution/durable-session-store.js";
import { emitTaskSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { TaskAgentRequestDelivery } from "#tasks/types.js";

export interface AgentRequestDelivery {
  readonly accumulateUsage?: boolean;
  readonly emitCompletion?: boolean;
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
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      if (delivery.emitCompletion === true && settled.accepted && request.result.isError !== true) {
        const emitted = await emitTaskSubagentEventStep({
          event: {
            type: "subagent.completed",
            data: {
              callId: request.result.callId,
              subagentName: request.result.subagentName,
              output:
                typeof request.result.output === "string"
                  ? request.result.output
                  : JSON.stringify(request.result.output),
            },
          },
          parentWritable: ctx.parentWritable,
          serializedContext: ctx.serializedContext,
        });
        return { serializedContext: emitted.serializedContext, sessionState: settled.sessionState };
      }
      return { serializedContext: ctx.serializedContext, sessionState: settled.sessionState };
    }
    case "agent-invoke": {
      const dispatched = await dispatchTaskAgentInvocationStep({
        ownerId: delivery.ownerId,
        replyTo: delivery.replyTo,
        request,
        serializedContext: ctx.serializedContext,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      switch (dispatched.kind) {
        case "dispatched": {
          const emitted = await emitTaskSubagentEventStep({
            event: dispatched.event,
            parentWritable: ctx.parentWritable,
            serializedContext: ctx.serializedContext,
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
            serializedContext: ctx.serializedContext,
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
