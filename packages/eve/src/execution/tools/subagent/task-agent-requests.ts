import type { DurableSessionState } from "#execution/durable-session-store.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolAgentRequest } from "#execution/tools/workflow/messages.js";

export interface AgentRequestDelivery {
  readonly ownerId: string;
  /** The requesting run's reply hook. */
  readonly replyTo: string;
  readonly request: WorkflowToolAgentRequest;
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
 * handle.
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
      });
      let serializedContext = settled.serializedContext;
      let sessionState = settled.sessionState;
      if (settled.completion !== undefined) {
        const emitted = await emitSubagentEventStep({
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
      });
      switch (dispatched.kind) {
        case "dispatched": {
          return await emitSubagentEventStep({
            event: dispatched.event,
            sessionWritable: ctx.sessionWritable,
            serializedContext: dispatched.serializedContext ?? ctx.serializedContext,
            sessionState: dispatched.sessionState,
          });
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
      }
    }
  }
}
