import { safeWaitUntil } from "#compiled/@workflow/core/runtime/wait-until.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.background");

/** Host-side ancillary work; durable execution and checkpoints remain awaited. */
export function background(task: Promise<unknown>): void {
  safeWaitUntil(task, (error) => logError(log, "Workflow background work failed", error));
}
