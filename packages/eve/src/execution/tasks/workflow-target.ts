import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import { walkCauseChain } from "#shared/errors.js";

/** Whether a workflow hook or run can no longer accept task traffic. */
export function isTaskWorkflowTargetGone(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      HookNotFoundError.is(candidate) ||
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}

/** Awaits traffic to a workflow hook or run, which a target already gone makes moot. */
export async function ignoreGoneTarget(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
  }
}
