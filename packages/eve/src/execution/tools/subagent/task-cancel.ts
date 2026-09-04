import type { TaskExecutorCancel } from "#execution/tasks/control.js";
import { cancelAgentHandleTurn } from "#subagents/cancel-turn.js";
import { deserializeContext } from "#context/serialize.js";
import { getAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import { readDurableSession, type DurableSessionState } from "#execution/session/state.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.agent-invocation-cancel");

/** Cancels the active child turn owned by a background subagent task. */
export const cancelBackgroundAgentTask: TaskExecutorCancel = async (input) => {
  const { session, serializedContext } = input;
  if (session === undefined || serializedContext === undefined) return;
  const handle = getAgentHandleStore(session.state)?.handles.find(
    (candidate) => candidate.phase === "claimed" && candidate.ownerId === input.entry.taskId,
  );
  if (handle === undefined || handle.phase !== "claimed") return;
  await cancelAgentHandleTurn({
    handle,
    context: () => deserializeContext(serializedContext),
  });
};

/** Cancels a child turn still claimed by a completed workflow-tool run. */
export async function cancelAgentInvocationOwner(input: {
  readonly ownerId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  const session = readDurableSession(input.sessionState);
  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (candidate): candidate is Extract<AgentHandle, { phase: "claimed" }> =>
      candidate.phase === "claimed" && candidate.ownerId === input.ownerId,
  );
  if (handles.length === 0) return;
  let context: ReturnType<typeof deserializeContext> | undefined;
  const loadContext = () => (context ??= deserializeContext(input.serializedContext));
  const outcomes = await Promise.allSettled(
    handles.map(async (handle) => {
      try {
        await cancelAgentHandleTurn({ handle, context: loadContext });
      } catch (error) {
        logError(log, "failed to cancel workflow-owned agent turn", error, {
          agentId: handle.identity.id,
          childSessionId: handle.address.sessionId,
          ownerId: input.ownerId,
        });
        throw error;
      }
    }),
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "Workflow-owned child cancellation did not complete.");
}
