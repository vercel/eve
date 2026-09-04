import type { DurableSessionState } from "#execution/session/state.js";
import { emitTurnEvent } from "#execution/turn/events.js";
import {
  dispatchTaskAgentInvocation,
  settleTaskAgentInvocation,
} from "#execution/tools/subagent/invoke.js";
import { sendInbox } from "#execution/inbox/send.js";
import type { TaskAgentRequestDelivery } from "#tasks/types.js";

interface AgentRequestDelivery {
  readonly accumulateUsage?: boolean;
  readonly ownerId: string;
  readonly replyTo: TaskAgentRequestDelivery["replyTo"];
  readonly request: TaskAgentRequestDelivery["request"];
  readonly taskId?: string;
}

interface TaskAgentRequestContext {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

interface AppliedTaskAgentRequest {
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
      const settled = await settleTaskAgentInvocation({
        accumulateUsage: delivery.accumulateUsage,
        ownerId: delivery.ownerId,
        result: request.result,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      return { serializedContext: ctx.serializedContext, sessionState: settled.sessionState };
    }
    case "agent-invoke": {
      const dispatched = await dispatchTaskAgentInvocation({
        ownerId: delivery.ownerId,
        replyTo: delivery.replyTo,
        request,
        serializedContext: ctx.serializedContext,
        sessionState: ctx.sessionState,
        taskId: delivery.taskId,
      });
      switch (dispatched.kind) {
        case "dispatched": {
          return await emitTurnEvent({
            event: dispatched.event,
            events: ctx.parentWritable,
            serializedContext: ctx.serializedContext,
            sessionState: dispatched.sessionState,
          });
        }
        case "failed":
          if (delivery.replyTo.kind !== "inbox")
            throw new Error("An agent invocation must reply to its owning inbox.");
          await sendInbox(delivery.replyTo.address, {
            eventId: `${delivery.replyTo.requestId}:failed`,
            kind: "agent.response",
            payload: { kind: "runtime-action-result", results: [dispatched.result] },
            requestId: delivery.replyTo.requestId,
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
