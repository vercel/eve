import { readDurableSession } from "#execution/durable-session-store.js";
import { isBetweenTurns, storedProjection } from "#harness/session-machine/view.js";
import {
  EntityConflictError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { isObject } from "#shared/guards.js";
import { createLogger, logError } from "#internal/logging.js";
import { walkCauseChain } from "#shared/errors.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { settleCancelledTurn } from "#execution/settle-cancelled-turn-step.js";
import type { PreparedLegacySession } from "./prepare-step.js";

/** Only the elected importer may stop work or append cancellation events. */
export async function interruptLegacySessionStep(prepared: PreparedLegacySession) {
  "use step";
  const { history: _history, ...originalSession } = prepared.originalSession;
  const originalState = { ...prepared.sessionState, snapshot: { session: originalSession } };
  try {
    await terminateChildSessionsStep({ sessionState: originalState });
  } catch (error) {
    logError(
      createLogger("execution.legacy-session"),
      "could not cooperatively stop legacy children",
      error,
    );
  }
  const world = await getWorld();
  const state = prepared.originalSession.state;
  const runIds = new Set<string>();
  // Import cancels discoverable work even when the old registry cannot pass current validation.
  const waitingRuns = state?.["eve.runtime.workflowToolRuns"];
  if (Array.isArray(waitingRuns)) {
    for (const entry of waitingRuns) {
      if (isObject(entry) && typeof entry.runId === "string") runIds.add(entry.runId);
    }
  }
  const handles = state?.["eve.agent.handles"];
  if (isObject(handles) && Array.isArray(handles.handles)) {
    for (const handle of handles.handles) {
      if (
        isObject(handle) &&
        isObject(handle.address) &&
        (handle.address.kind === "agent/local" || handle.address.kind === "agent/self") &&
        typeof handle.address.sessionId === "string"
      )
        runIds.add(handle.address.sessionId);
    }
  }
  const tasks = state?.["eve.tasks"];
  if (isObject(tasks) && Array.isArray(tasks.tasks)) {
    for (const task of tasks.tasks) {
      if (isObject(task) && typeof task.taskRunId === "string") runIds.add(task.taskRunId);
    }
  }
  for (const runId of runIds) {
    if (!runId || runId === prepared.sessionState.sessionId) continue;
    try {
      await cancelRun(world, runId, { cancelReason: "Session upgraded" });
    } catch (error) {
      if (
        ![...walkCauseChain(error)].some(
          (cause) =>
            EntityConflictError.is(cause) ||
            RunExpiredError.is(cause) ||
            WorkflowRunNotFoundError.is(cause),
        )
      )
        throw error;
    }
  }
  if (
    prepared.input.inputCommitted ||
    isBetweenTurns(storedProjection(readDurableSession(prepared.sessionState).state))
  )
    return {
      history: prepared.history,
      sessionState: prepared.sessionState,
      serializedContext: prepared.serializedContext,
    };
  return await settleCancelledTurn({
    history: prepared.history,
    reportUsage: false,
    sessionWritable: prepared.input.sessionWritable,
    serializedContext: prepared.serializedContext,
    sessionState: prepared.sessionState,
  });
}
