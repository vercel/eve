import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { isInactiveTimeoutTarget } from "#execution/session/timeout-steps.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  startWorkflowOnCurrentDeployment,
  taskTimerWorkflowReference,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { readTaskTimer, writeTaskTimer } from "#tasks/state.js";
import type { TaskTimerWorkflowInput } from "#tasks/timer.js";

const log = createLogger("tasks.timer");

/**
 * Starts the owner's timer for `wakeAt` and records it. The timer it
 * replaces would fire later than needed, so it is cancelled; a timer this
 * step fails to cancel only wakes the owner once more for nothing.
 */
export async function armTaskTimerStep(input: {
  readonly sessionState: DurableSessionState;
  readonly wakeAt: string;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const timerInput: TaskTimerWorkflowInput = {
    ownerRunId: getWorkflowMetadata().workflowRunId,
    token: sessionCommandHookToken(session.sessionId),
    wakeAt: input.wakeAt,
  };
  const run = await startWorkflowOnCurrentDeployment(taskTimerWorkflowReference, [timerInput]);
  const replaced = readTaskTimer(session.state);
  if (replaced !== undefined) await cancelTaskTimer(replaced.runId, "Replaced by an earlier timer");
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: {
        ...session,
        state: writeTaskTimer(session.state, { runId: run.runId, wakeAt: input.wakeAt }),
      },
      state: input.sessionState,
    }),
  };
}

/** Wakes the owner. A session that already ended has nothing left to time out. */
export async function signalTaskDeadlineStep(input: TaskTimerWorkflowInput): Promise<void> {
  "use step";

  try {
    await resumeSessionInbox(input.token, {
      kind: "task.deadline",
      ownerRunId: input.ownerRunId,
      wakeAt: input.wakeAt,
    });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) throw error;
  }
}

/** Best-effort: a timer that keeps running only re-evaluates the table once more. */
export async function cancelTaskTimer(runId: string, reason: string): Promise<void> {
  try {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      logError(log, "failed to cancel a task timer", error, { runId });
    }
  }
}
