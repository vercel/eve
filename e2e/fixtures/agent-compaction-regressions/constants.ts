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

/** Leading content-output text that must reach the compaction model. */
export const CONTENT_OUTPUT_LEAD_MARKER = "CONTENT_OUTPUT_TEXT_BEFORE_FILE";

/** Trailing content-output text that must reach the compaction model. */
export const CONTENT_OUTPUT_TAIL_MARKER = "CONTENT_OUTPUT_TEXT_AFTER_FILE";

/**
 * Buried near the start of the inline file payload (base64 alphabet only).
 * It can appear in the checkpoint only if the raw payload reached the
 * compaction prompt — a summarizer cannot invent it — so its presence
 * proves the payload leaked instead of rendering as a stub. Prefix-clipping
 * the serialized output (the old behavior) exposes it by construction.
 */
export const CONTENT_OUTPUT_PAYLOAD_CANARY = "QQPAYLOADCANARYXKJMZZ";

/**
 * Filename of the emitted file part. It exists nowhere in the transcript
 * except the rendered attachment stub, so the checkpoint can carry it only
 * if the stub reached the compaction prompt.
 */
export const CONTENT_OUTPUT_FILENAME = "compaction-evidence.bin";

/** Reported by the task model only when the checkpoint honored the full contract. */
export const CONTENT_OUTPUT_COMPACTION_MARKER = "CONTENT_OUTPUT_TEXT_SURVIVED_COMPACTION";
