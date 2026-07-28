/**
 * Rough token estimate: serialized JSON length / 4, with inline file data
 * counted at a fixed cost instead of as base64 text. Good enough for deciding
 * whether compaction is needed; the real token count comes back from the model
 * each step via `CompactionConfig.lastKnownInputTokens`.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value, replaceInlineFileData).length / 4;
}

function replaceInlineFileData(this: unknown, key: string, value: unknown): unknown {
  if (
    key !== "data" ||
    !isRecord(this) ||
    this.type !== "file" ||
    !isRecord(value) ||
    value.type !== "data" ||
    typeof value.data !== "string"
  ) {
    return value;
  }

  return { ...value, data: "[inline file data]" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
