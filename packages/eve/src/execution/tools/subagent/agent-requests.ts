import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invoke-agent.js";
import { startAgentTasks } from "#tasks/owner-body.js";

export interface AgentRequestDelivery {
  readonly ownerId: string;
  readonly replyTo: string;
  readonly request: AgentInvocationRequest;
}

/**
 * Starts the agent a workflow tool body asked for with `ctx.agent`. The
 * session owns the task because it holds the auth, capabilities, and
 * sandbox the child needs; the result goes to the body's reply hook.
 */
export async function applyAgentRequest(
  delivery: AgentRequestDelivery,
  cursor: SessionStateCursor,
): Promise<void> {
  await startAgentTasks(cursor, [
    {
      callId: delivery.request.invocationId,
      input: delivery.request.input,
      workflowCaller: { replyTo: delivery.replyTo, runId: delivery.ownerId },
    },
  ]);
}
