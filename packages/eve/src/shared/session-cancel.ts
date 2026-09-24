// The one validation for `Session.cancel` options, shared by the eve channel
// route, channel sessions, and the session inbox. It stays free of imports so
// the session workflow body can read it.

/**
 * Longest task ID a caller may name. Task IDs eve derives are
 * `<name>-<6 base32>`, at most 55 characters.
 */
export const MAX_TASK_ID_LENGTH = 128;

/** Why the options of one cancel request are invalid, or `undefined` when they are valid. */
export function describeInvalidCancelOptions(options: {
  readonly taskId?: unknown;
  readonly tasks?: unknown;
  readonly turnId?: unknown;
}): string | undefined {
  const { taskId, tasks, turnId } = options;
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    return "Expected 'turnId' to be a non-empty string.";
  }
  if (tasks !== undefined && typeof tasks !== "boolean") {
    return "Expected 'tasks' to be a boolean.";
  }
  if (taskId === undefined) return undefined;
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH) {
    return `Expected 'taskId' to be a non-empty string of at most ${String(MAX_TASK_ID_LENGTH)} characters.`;
  }
  if (tasks === true || turnId !== undefined) {
    return "'taskId' cancels one task and leaves the turn running, so it cannot be combined with 'tasks' or 'turnId'.";
  }
  return undefined;
}
