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
