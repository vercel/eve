import type { DurableSessionState } from "#execution/durable-session-store.js";
import { handleSubagentEvent } from "#execution/tools/subagent/handle-event.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { TaskAgentRequestDelivery } from "#tasks/types.js";

export interface AgentRequestDelivery {
  readonly ownerId: string;
  readonly replyTo: TaskAgentRequestDelivery["replyTo"];
  readonly request: TaskAgentRequestDelivery["request"];
  readonly taskId?: string;
}

export interface TaskAgentRequestContext {
  readonly sessionWritable: WritableStream<Uint8Array>;
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
        ownerId: delivery.ownerId,
        result: request.result,
        serializedContext: ctx.serializedContext,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      let serializedContext = settled.serializedContext;
      let sessionState = settled.sessionState;
      if (settled.completion !== undefined) {
        const emitted = await handleSubagentEvent({
          event: settled.completion,
          sessionWritable: ctx.sessionWritable,
          serializedContext,
          sessionState: settled.sessionState,
        });
        serializedContext = emitted.serializedContext;
        sessionState = emitted.sessionState;
      }
      await resumeHookStep(
        delivery.replyTo,
        { kind: "agent-settled", callId: request.result.callId },
        { ifPresent: true },
      );
      return {
        serializedContext,
        sessionState,
      };
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
          const emitted = await handleSubagentEvent({
            event: dispatched.event,
            sessionWritable: ctx.sessionWritable,
            serializedContext: dispatched.serializedContext ?? ctx.serializedContext,
            sessionState: dispatched.sessionState,
          });
          return {
            serializedContext: emitted.serializedContext,
            sessionState: emitted.sessionState,
          };
        }
        case "failed":
          await resumeHookStep(delivery.replyTo, {
            kind: "runtime-action-result",
            results: [dispatched.result],
          });
          return {
            serializedContext: dispatched.serializedContext ?? ctx.serializedContext,
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
