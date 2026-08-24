import type { RunControlMessage } from "#execution/tool-run/messages.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.tool-run");

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const COOPERATIVE_CANCEL_GRACE_MS = 1_000;
const COOPERATIVE_CANCEL_POLL_MS = 50;

/**
 * Cancels one workflow tool run. First a `cancel` control message so the body
 * observes `ctx.abortSignal`, unwinds its awaits, and runs `finally`; the run
 * then ends itself with a cancelled outcome. If it does not settle within a
 * grace period — a body that never checks the signal — `cancelRun` forces it
 * terminal. A run that already finished or expired is not an error, and any
 * other failure is logged rather than thrown: the caller has already committed
 * the cancellation the run was serving and must not roll it back.
 */
export async function cancelToolRun(input: {
  readonly callId: string;
  readonly hookToken: string;
  readonly reason: string;
  readonly runId: string;
  readonly toolName: string;
}): Promise<void> {
  const world = await getWorld();
  const cancel: RunControlMessage = { kind: "cancel", reason: input.reason };
  try {
    await resumeHook(input.hookToken, cancel);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return; // Already gone; nothing left to cancel.
    logError(log, "failed to signal a workflow tool run to cancel", error, {
      callId: input.callId,
      runId: input.runId,
      toolName: input.toolName,
    });
  }

  if (await settlesWithinGrace(input.runId)) return;

  try {
    await cancelRun(world, input.runId, { cancelReason: input.reason });
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    logError(log, "failed to cancel workflow tool run; it may run to completion", error, {
      callId: input.callId,
      runId: input.runId,
      toolName: input.toolName,
    });
  }
}

/** Polls the run until it reaches a terminal status or the grace period ends. */
async function settlesWithinGrace(runId: string): Promise<boolean> {
  const run = getRun(runId);
  const deadline = Date.now() + COOPERATIVE_CANCEL_GRACE_MS;
  while (Date.now() < deadline) {
    try {
      if (TERMINAL_RUN_STATUSES.has(await run.status)) return true;
    } catch (error) {
      if (isTaskWorkflowTargetGone(error)) return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, COOPERATIVE_CANCEL_POLL_MS));
  }
  return false;
}
