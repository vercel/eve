import type { RuntimeSession } from "#subagents/handle-dispatch.js";
import type { TaskExecutorCancel } from "#execution/tasks/parent/task-cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.agent-invocation-cancel");

/** Cancels the active child turn owned by a background subagent task. */
export const cancelBackgroundAgentTask: TaskExecutorCancel = async (input) => {
  if (input.session === undefined || input.serializedContext === undefined) return;
  const session = input.session as RuntimeSession;
  const handle = getAgentHandleStore(session.state)?.handles.find(
    (candidate) => candidate.phase === "claimed" && candidate.ownerId === input.entry.taskId,
  );
  if (handle === undefined || handle.phase !== "claimed") return;
  if (handle.address.kind !== "agent/remote") {
    await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId });
    return;
  }
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const selection = getDynamicSubagentSelection(ctx, handle.identity.nodeId);
  const remote = resolveRemoteAgentForAction({
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: handle.identity.nodeId,
    registry: bundle.subagentRegistry.subagentsByNodeId,
    remoteAgentName: handle.identity.name,
  });
  await cancelRemoteAgentTurn({
    remote: { ...remote, url: handle.address.url },
    sessionId: handle.address.sessionId,
  });
};

/** Cancels a child turn still claimed by a completed workflow-tool run. */
export async function cancelAgentInvocationOwnerStep(input: {
  readonly ownerId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  const session = await readDurableSession(input.sessionState);
  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (candidate): candidate is Extract<AgentHandle, { phase: "claimed" }> =>
      candidate.phase === "claimed" && candidate.ownerId === input.ownerId,
  );
  if (handles.length === 0) return;
  const remoteContext = handles.some((handle) => handle.address.kind === "agent/remote")
    ? await deserializeContext(input.serializedContext)
    : undefined;
  await Promise.all(
    handles.map(async (handle) => {
      try {
        if (handle.address.kind !== "agent/remote") {
          await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId });
          return;
        }
        const bundle = remoteContext!.require(BundleKey);
        const selection = getDynamicSubagentSelection(remoteContext!, handle.identity.nodeId);
        const remote = resolveRemoteAgentForAction({
          dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
          nodeId: handle.identity.nodeId,
          registry: bundle.subagentRegistry.subagentsByNodeId,
          remoteAgentName: handle.identity.name,
        });
        await cancelRemoteAgentTurn({
          remote: { ...remote, url: handle.address.url },
          sessionId: handle.address.sessionId,
        });
      } catch (error) {
        logError(log, "failed to cancel workflow-owned agent turn", error, {
          agentId: handle.identity.id,
          childSessionId: handle.address.sessionId,
          ownerId: input.ownerId,
        });
      }
    }),
  );
}
