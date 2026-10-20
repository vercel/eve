import type { ApprovalContext } from "#approval/definition.js";

/**
 * Approval contexts built for the re-check of a call a person already approved.
 * eve re-runs the approval policy just before such a call runs, and a `denied`
 * result there cancels it.
 */
const rechecks = new WeakSet<object>();

export function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  rechecks.add(context);
  return context;
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return rechecks.has(context);
}
