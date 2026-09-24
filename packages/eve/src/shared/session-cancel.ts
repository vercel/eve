// The one validation for `Session.cancel` options, shared by the eve channel
// route, channel sessions, and the session inbox. It stays free of imports so
// the session workflow body can read it.

/**
 * Why the options of one cancel request are invalid, or `undefined` when they
 * are valid. The removed `taskId` and `tasks` options are refused rather than
 * ignored: a caller that still sends them expects a narrower cancel than the
 * one it would get.
 */
export function describeInvalidCancelOptions(options: {
  readonly taskId?: unknown;
  readonly tasks?: unknown;
  readonly turnId?: unknown;
}): string | undefined {
  const { taskId, tasks, turnId } = options;
  if (taskId !== undefined || tasks !== undefined) {
    return "'taskId' and 'tasks' are no longer supported: session.cancel() stops the turn and every working task. To stop one task, the agent calls task_cancel.";
  }
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    return "Expected 'turnId' to be a non-empty string.";
  }
  return undefined;
}
