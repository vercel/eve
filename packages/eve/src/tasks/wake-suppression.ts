import type { DeliverPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const TASK_WAKE_SUPPRESSIONS_STATE_KEY = "eve.tasks.wakeSuppressions";

interface TaskWakeSuppression {
  readonly taskId: string;
}

interface TaskWakeSuppressionStore {
  readonly entries: readonly TaskWakeSuppression[];
}

/** Claims each task's next ready wake for the active `task_await`. */
export function suppressAwaitedTaskWakes(
  session: HarnessSession,
  taskIds: readonly string[],
): HarnessSession {
  const existing = readSuppressions(session.state);
  return writeSuppressions(session, [...existing, ...taskIds.map((taskId) => ({ taskId }))]);
}

/**
 * Drops task wake payloads claimed by `task_await`. Every matching entry is
 * consumed: one await suppresses only the ready transition it observes.
 * Turn cancellation clears outstanding claims before the parent parks again.
 */
export function consumeAwaitedTaskWakes(
  session: HarnessSession,
  payloads: readonly DeliverPayload[],
): { readonly payloads: readonly DeliverPayload[]; readonly session: HarnessSession } {
  const existing = readSuppressions(session.state);
  if (existing.length === 0) return { payloads, session };

  const consumedTaskIds = new Set<string>();
  const kept = payloads.filter((payload) => {
    const taskId = payload.taskNotification?.taskId;
    if (taskId === undefined || !existing.some((entry) => entry.taskId === taskId)) return true;
    consumedTaskIds.add(taskId);
    return false;
  });
  if (consumedTaskIds.size === 0) return { payloads, session };

  return {
    payloads: kept,
    session: writeSuppressions(
      session,
      existing.filter((entry) => !consumedTaskIds.has(entry.taskId)),
    ),
  };
}

/** Releases claims from a cancelled task-await turn. */
export function clearAwaitedTaskWakeSuppressions(session: HarnessSession): HarnessSession {
  return writeSuppressions(session, []);
}

function readSuppressions(state: SessionStateMap | undefined): readonly TaskWakeSuppression[] {
  const raw = state?.[TASK_WAKE_SUPPRESSIONS_STATE_KEY];
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || !("entries" in raw)) {
    throw new Error(`Corrupt task wake suppressions under "${TASK_WAKE_SUPPRESSIONS_STATE_KEY}".`);
  }
  const entries = raw.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Corrupt task wake suppressions under "${TASK_WAKE_SUPPRESSIONS_STATE_KEY}".`);
  }
  return entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("taskId" in entry) ||
      typeof entry.taskId !== "string"
    ) {
      throw new Error(
        `Corrupt task wake suppressions under "${TASK_WAKE_SUPPRESSIONS_STATE_KEY}".`,
      );
    }
    return { taskId: entry.taskId };
  });
}

function writeSuppressions(
  session: HarnessSession,
  entries: readonly TaskWakeSuppression[],
): HarnessSession {
  const state = { ...session.state };
  if (entries.length === 0) delete state[TASK_WAKE_SUPPRESSIONS_STATE_KEY];
  else state[TASK_WAKE_SUPPRESSIONS_STATE_KEY] = { entries } satisfies TaskWakeSuppressionStore;
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
}
