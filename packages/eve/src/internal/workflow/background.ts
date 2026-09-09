import { safeWaitUntil } from "#compiled/@workflow/core/runtime/wait-until.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.background");

/** Keep host work alive after disconnect; callers may also await a durability boundary. */
export function background(task: Promise<unknown>): void {
  safeWaitUntil(task, (error) => logError(log, "Workflow background work failed", error));
}
