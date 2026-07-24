/** Fixture evidence emitted by the test-only second-compaction trigger tool. */
export const SECOND_CHECKPOINT_MARKER = "SECOND_CHECKPOINT_READY";

/** Trailing sentinel of the task-survival case's long task message. */
export const TASK_TAIL_SENTINEL = "TASK_TAIL_SENTINEL_AFTER_PADDING";

/**
 * Reported by the mock task model only when, after at least one compaction,
 * the verbatim task sentinel is still visible in a user message.
 */
export const TASK_PRESERVED_MARKER = "TASK_PRESERVED_AFTER_COMPACTION";

/** Checkpoint marker the harness inserts when compaction summarizes. */
export const COMPACTION_CHECKPOINT_TEXT = "Summary of our conversation so far:";
