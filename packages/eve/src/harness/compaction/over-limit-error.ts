/**
 * Compaction finished and the history is still over the limit. Retrying would
 * summarize the same history again, so the step reports it as a terminal failure.
 */
export class CompactionOverLimitError extends Error {
  override readonly name = "CompactionOverLimitError";
}
