import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { isInactiveTimeoutTarget } from "#execution/session/timeout-steps.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { isSessionHandoffPending, resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  startWorkflowOnCurrentDeployment,
  taskTimerWorkflowReference,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { readTaskTimer, writeTaskTimer } from "#tasks/state.js";
import type { TaskTimerWorkflowInput } from "#tasks/timer.js";

// The timer workflow imports this module, so its module scope has no side
// effects: the logger is created inside the functions that use it.

/**
 * Starts the owner's timer for `wakeAt` and records it with the owner run
 * that armed it. The timer it replaces is cancelled; a timer this step fails
 * to cancel only wakes the owner once more for nothing.
 */
export async function armTaskTimerStep(input: {
  readonly sessionState: DurableSessionState;
  readonly wakeAt: string;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const ownerRunId = getWorkflowMetadata().workflowRunId;
  const timerInput: TaskTimerWorkflowInput = {
    ownerRunId,
    token: sessionCommandHookToken(session.sessionId),
    wakeAt: input.wakeAt,
  };
  const run = await startWorkflowOnCurrentDeployment(taskTimerWorkflowReference, [timerInput]);
  const replaced = readTaskTimer(session.state);
  if (replaced !== undefined) await cancelTaskTimer(replaced.runId, "Replaced by another timer");
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: {
        ...session,
        state: writeTaskTimer(session.state, {
          ownerRunId,
          runId: run.runId,
          wakeAt: input.wakeAt,
        }),
      },
      state: input.sessionState,
    }),
  };
}

/** Stops the armed timer once no task needs a wake, so a settled session is not woken. */
export async function cancelTaskTimerStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const armed = readTaskTimer(session.state);
  if (armed === undefined) return input;
  await cancelTaskTimer(armed.runId, "No task deadline remains");
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: { ...session, state: writeTaskTimer(session.state, undefined) },
      state: input.sessionState,
    }),
  };
}

/**
 * Wakes the owner. Only a session that is gone swallows the failure; during
 * a handoff that outlasts the inbox's retry window the step fails and
 * Workflow retries it. A signal that never lands is recovered by the owner,
 * which re-arms an overdue timer.
 */
export async function signalTaskDeadlineStep(input: TaskTimerWorkflowInput): Promise<void> {
  "use step";

  try {
    await resumeSessionInbox(input.token, {
      kind: "task.deadline",
      ownerRunId: input.ownerRunId,
      wakeAt: input.wakeAt,
    });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error) || (await isSessionHandoffPending(input.token))) {
      throw error;
    }
  }
}

/** Best-effort: a timer that keeps running only re-evaluates the table once more. */
export async function cancelTaskTimer(runId: string, reason: string): Promise<void> {
  try {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      logError(createLogger("tasks.timer"), "failed to cancel a task timer", error, { runId });
    }
  }
}
