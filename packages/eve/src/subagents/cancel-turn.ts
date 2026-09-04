import type { CancelTurnResult } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { AgentHandle } from "#subagents/handles/store.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";

/** Cancels at the recorded child address without restoring context for local sessions. */
export async function cancelAgentHandleTurn(input: {
  readonly handle: Extract<AgentHandle, { phase: "claimed" | "running" }>;
  readonly context: () => Promise<ContextContainer>;
  readonly taskId?: string;
}): Promise<CancelTurnResult> {
  const { handle, taskId } = input;
  const target: { sessionId: string; taskId?: string } = { sessionId: handle.address.sessionId };
  if (taskId !== undefined) target.taskId = taskId;
  if (handle.address.kind !== "agent/remote") {
    return await requestWorkflowTurnCancellation(target);
  }
  const ctx = await input.context();
  const selection = getDynamicSubagentSelection(ctx, handle.identity.nodeId);
  const remote = resolveRemoteAgentForAction({
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: handle.identity.nodeId,
    registry: ctx.require(BundleKey).subagentRegistry.subagentsByNodeId,
    remoteAgentName: handle.identity.name,
  });
  return await cancelRemoteAgentTurn({ remote: { ...remote, url: handle.address.url }, ...target });
}
