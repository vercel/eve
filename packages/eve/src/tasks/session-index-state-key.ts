/**
 * Session-state key for the parent's live-task index.
 *
 * The parent session stores only this index; the mutable task record lives in
 * the dedicated durable task run. The PR #1190 spike found the session-state
 * boundary unworkable for task state itself: session state threads through
 * step results, while callback routes and child executors must update tasks
 * without holding the current snapshot.
 *
 * Lives apart from the zod-backed store so workflow-driver queries can read
 * parent-owned task metadata without pulling the validator into their bundle.
 */
export const SESSION_TASKS_STATE_KEY = "eve.tasks";
