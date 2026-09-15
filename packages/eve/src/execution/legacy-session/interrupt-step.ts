import {
  EntityConflictError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { isObject } from "#shared/guards.js";
import { createLogger, logError } from "#internal/logging.js";
import { walkCauseChain } from "#shared/errors.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import type { PreparedLegacySession } from "./prepare-step.js";

/** Only the elected importer may stop work or append cancellation events. */
export async function interruptLegacySessionStep(prepared: PreparedLegacySession) {
  "use step";
  const originalState = {
    ...prepared.sessionState,
    snapshot: {
      session: {
        ...prepared.originalSession,
        history: prepared.sessionState.snapshot.session.history,
      },
    },
  };
  try {
    await terminateChildSessionsStep({
      sessionState: originalState,
      serializedContext: prepared.serializedContext,
    });
  } catch (error) {
    logError(
      createLogger("execution.legacy-session"),
      "could not cooperatively stop legacy children",
      error,
    );
  }
  const world = await getWorld();
  const state = prepared.originalSession.state;
  const runIds = new Set(getWorkflowToolRuns(state).map((run) => run.runId));
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
  if (prepared.input.inputCommitted || prepared.sessionState.emissionState.turnId === "")
    return {
      sessionState: prepared.sessionState,
      serializedContext: prepared.serializedContext,
    };
  return await settleCancelledTurnStep({
    parentWritable: prepared.input.parentWritable,
    serializedContext: prepared.serializedContext,
    sessionState: prepared.sessionState,
  });
}
