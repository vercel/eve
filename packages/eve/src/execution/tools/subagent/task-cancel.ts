import type { RuntimeSession } from "#subagents/handle-dispatch.js";
import type { TaskExecutorCancel } from "#execution/tasks/parent/task-cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";

/** Cancels the active child turn owned by a background subagent task. */
export const cancelBackgroundAgentTask: TaskExecutorCancel = async (input) => {
  if (input.session === undefined || input.serializedContext === undefined) return;
  const session = input.session as RuntimeSession;
  const handle = getAgentHandleStore(session.state)?.handles.find(
    (candidate) => candidate.phase === "claimed" && candidate.taskId === input.entry.taskId,
  );
  if (handle === undefined || handle.phase !== "claimed") return;
  if (handle.address.kind !== "agent/remote") {
    await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId });
    return;
  }
  const bundle = (await deserializeContext(input.serializedContext)).require(BundleKey);
  const remote = resolveRemoteAgentForAction({
    nodeId: handle.identity.nodeId,
    registry: bundle.subagentRegistry.subagentsByNodeId,
    remoteAgentName: handle.identity.name,
  });
  await cancelRemoteAgentTurn({
    remote: { ...remote, url: handle.address.url },
    sessionId: handle.address.sessionId,
  });
};
