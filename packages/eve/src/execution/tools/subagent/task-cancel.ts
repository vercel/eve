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

/** Cancels child turns and their nested tasks still owned by a background task. */
export const cancelBackgroundAgentTask: TaskExecutorCancel = async (input) => {
  if (input.session === undefined || input.serializedContext === undefined) return;
  await cancelAgentInvocationOwner({
    ownerId: input.entry.task.taskId,
    serializedContext: input.serializedContext,
    session: input.session,
  });
};

/** Cancels a child turn still claimed by a completed workflow-tool run. */
export async function cancelAgentInvocationOwnerStep(input: {
  readonly ownerId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  try {
    await cancelAgentInvocationOwner({
      ownerId: input.ownerId,
      serializedContext: input.serializedContext,
      session: readDurableSession(input.sessionState),
    });
  } catch (error) {
    logError(log, "failed to cancel workflow-owned agent turn", error, { ownerId: input.ownerId });
  }
}

async function cancelAgentInvocationOwner(input: {
  readonly ownerId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly session: Pick<RuntimeSession, "state">;
}): Promise<void> {
  const handles = (getAgentHandleStore(input.session.state)?.handles ?? []).filter(
    (candidate): candidate is Extract<AgentHandle, { phase: "claimed" }> =>
      candidate.phase === "claimed" && candidate.ownerId === input.ownerId,
  );
  if (handles.length === 0) return;
  let remoteContext: ReturnType<typeof deserializeContext> | undefined;
  const results = await Promise.allSettled(
    handles.map(async (handle) => {
      if (handle.address.kind !== "agent/remote") {
        await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId, tasks: true });
        return;
      }
      remoteContext ??= deserializeContext(input.serializedContext);
      const ctx = await remoteContext;
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
        tasks: true,
      });
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Failed to cancel owned agent turns.",
    );
}
