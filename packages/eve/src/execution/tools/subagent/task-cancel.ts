import type { TaskExecutorCancel } from "#execution/tasks/parent/task-cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.agent-invocation-cancel");

type AgentInvocationHandle = Pick<
  Extract<AgentHandle, { phase: "claimed" }>,
  "address" | "identity"
>;

/** Cancels child turns and their nested tasks still owned by a background task. */
export const cancelBackgroundAgentTask: TaskExecutorCancel = async (input) => {
  if (input.session === undefined || input.serializedContext === undefined) return;
  const handles = (getAgentHandleStore(input.session.state)?.handles ?? []).flatMap((handle) =>
    handle.phase === "claimed" && handle.ownerId === input.entry.task.taskId
      ? [{ address: handle.address, identity: handle.identity }]
      : [],
  );
  await cancelAgentInvocationOwner({
    ownerId: input.entry.task.taskId,
    serializedContext: input.serializedContext,
    handles,
  });
};

/** Cancels a child turn still claimed by a completed workflow-tool run. */
export async function cancelAgentInvocationOwnerStep(input: {
  readonly handles: readonly AgentInvocationHandle[];
  readonly ownerId: string;
  readonly serializedContext?: Record<string, unknown>;
}): Promise<void> {
  "use step";

  try {
    await cancelAgentInvocationOwner(input);
  } catch (error) {
    logError(log, "failed to cancel workflow-owned agent turn", error, { ownerId: input.ownerId });
  }
}

async function cancelAgentInvocationOwner(input: {
  readonly handles: readonly AgentInvocationHandle[];
  readonly ownerId: string;
  readonly serializedContext?: Record<string, unknown>;
}): Promise<void> {
  if (input.handles.length === 0) return;
  let remoteContext: ReturnType<typeof deserializeContext> | undefined;
  const results = await Promise.allSettled(
    input.handles.map(async (handle) => {
      if (handle.address.kind !== "agent/remote") {
        await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId, tasks: true });
        return;
      }
      if (input.serializedContext === undefined) {
        throw new Error("Missing serialized context for remote agent cancellation.");
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
