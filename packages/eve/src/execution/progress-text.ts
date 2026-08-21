export const MAX_PROGRESS_TEXT_LENGTH = 500;

/** Normalizes bounded untrusted presentation text before it reaches a renderer. */
export function normalizeProgressText(text: string): string {
  return (
    text
      // Control bytes are untrusted presentation data, not meaningful progress text.
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_PROGRESS_TEXT_LENGTH)
  );
}
