/**
 * Compaction can't bring the request under the limit by eve's estimate. The
 * step sends the request uncompacted, so the provider decides whether it fits.
 */
export class CompactionOverLimitError extends Error {
  override readonly name = "CompactionOverLimitError";
}
