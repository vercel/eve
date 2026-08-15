/**
 * Rough token estimate: serialized JSON length / 4. Good enough for
 * deciding whether compaction is needed; the real token count comes back
 * from the model each step via `CompactionConfig.lastKnownInputTokens`.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}
