import type { SessionStateMap } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import { readTaskTable, type TaskTable } from "#tasks/table.js";

// Import only from step modules, never from code a workflow body runs: the
// logger imports Node.js built-ins. Workflow bodies read the table with
// getTaskTable from tasks/state.ts.

const log = createLogger("tasks.owner");

/**
 * Reads the task table and logs records that could not be decoded. They are
 * left out of the returned table, so the owner's next write removes them.
 */
export function readTasks(session: { readonly state?: SessionStateMap }): TaskTable {
  const { lost, table } = readTaskTable(session.state);
  for (const task of lost) {
    log.warn("dropped an unreadable task record", {
      reason: task.reason,
      taskId: task.id,
      taskName: task.name,
    });
  }
  return table;
}
