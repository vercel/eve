export const MAX_ACTIVITY_TEXT_LENGTH = 500;

/** Normalizes bounded untrusted presentation text before it reaches a renderer. */
export function normalizePresentationText(text: string): string {
  return (
    text
      // Control bytes are untrusted presentation data, not meaningful activity text.
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ACTIVITY_TEXT_LENGTH)
  );
}

/**
 * The first sentence of the text's first non-empty line, normalized: a brief
 * for a message or result. Returns `undefined` when there is no text.
 */
export function firstSentence(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const normalized = normalizePresentationText(line);
    if (normalized === "") continue;
    // A sentence ends at `.`, `!`, or `?` before a capital, digit, or quote, so
    // `e.g. the` and `eve@0.58.1` stay whole.
    return normalized.split(/(?<=[.!?])\s+(?=[\p{Lu}\d"'`(])/u, 1)[0];
  }
  return undefined;
}
