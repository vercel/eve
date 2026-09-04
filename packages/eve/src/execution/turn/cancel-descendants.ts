import { cancelAgentHandleTurn } from "#subagents/cancel-turn.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/session/state.js";
import { cancelWorkflowToolRun } from "#execution/workflow-tool/cancel.js";
import { getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ContextContainer } from "#context/container.js";

const log = createLogger("execution.cancel-descendant-turns");

type RunningAgentHandle = Extract<AgentHandle, { phase: "claimed" | "running" }>;

/**
 * Cancels every running delegated child recorded in the agent handle store
 * and every workflow tool run the turn is waiting on.
 */
export async function cancelDescendantTurns(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  const session = readDurableSession(input.sessionState);
  const workflowToolRuns = getWorkflowToolRuns(session.state);
  const workflowOwnerIds = new Set(workflowToolRuns.map((run) => run.runId));
  const running = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" ||
      (handle.phase === "claimed" && workflowOwnerIds.has(handle.ownerId)),
  );
  let context: Promise<ContextContainer> | undefined;
  const getContext = () => (context ??= deserializeContext(input.serializedContext));

  const outcomes = await Promise.allSettled([
    ...workflowToolRuns.map((record) =>
      cancelWorkflowToolRun(record, "The turn that called the tool was cancelled."),
    ),
    ...running.map((handle) => cancelDescendant(handle, getContext)),
  ]);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "Descendant cancellation did not complete.");
}

async function cancelDescendant(
  handle: RunningAgentHandle,
  context: () => Promise<ContextContainer>,
): Promise<void> {
  const remote = handle.address.kind === "agent/remote";
  const details = {
    callId: handle.phase === "running" ? handle.operation.callId : handle.callId,
    childSessionId: handle.address.sessionId,
    subagentName: handle.identity.name,
  };
  try {
    const result = await cancelAgentHandleTurn({ handle, context });
    if (result.status !== "accepted") log.debug("descendant has no active turn", details);
  } catch (error) {
    logError(
      log,
      remote ? "failed to cancel remote descendant turn" : "failed to cancel local descendant turn",
      error,
      details,
    );
    throw error;
  }
}
