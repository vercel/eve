/**
 * Compaction finished and the history is still over the limit. Retrying would
 * summarize the same history again, so the step reports it as a terminal failure.
 */
export class CompactionOverLimitError extends Error {
  override readonly name = "CompactionOverLimitError";
}

/**
 * A strategy returned a history the harness cannot use: it dropped a tool call or result, or does
 * not start with a user message. A retry would run the strategy on the same history again.
 */
export class CompactionInvalidResultError extends Error {
  override readonly name = "CompactionInvalidResultError";
}
