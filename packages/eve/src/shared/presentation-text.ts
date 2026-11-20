export const MAX_ACTIVITY_TEXT_LENGTH = 500;

export function normalizePresentationText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ACTIVITY_TEXT_LENGTH);
}

export function firstSentence(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const normalized = normalizePresentationText(line);
    if (normalized === "") continue;
    return normalized.split(/(?<=[.!?])(?<!(?:^|\s)\d{1,2}\.)\s+(?=[\p{Lu}"'`(])/u, 1)[0];
  }
  return undefined;
}
