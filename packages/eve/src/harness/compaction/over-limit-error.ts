/**
 * What the agent sends besides the history leaves it no room under the limit compaction measures
 * against. Under the threshold, the step compacts against the model's window instead; under the
 * window, only the turn fails, without a provider call.
 */
export class CompactionOverLimitError extends Error {
  override readonly name = "CompactionOverLimitError";
}
