const STREAMING_PIECE_MIN_LENGTH = 50;
const MIN_REASONING_PIECE_LENGTH = 12;

const HEADING = /(?:^|\n)[ \t]*\*\*([^*\n]+)\*\*/gu;
const SENTENCE_BOUNDARY = /(?<=[.!?])(?<!(?:^|\s)\d{1,2}\.)\s+(?=[\p{Lu}"'`(])/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,2}[.)])\s+/u;

export function reasoningStatus(
  reasoning: string,
  options?: { readonly complete?: boolean },
): string | undefined {
  const heading = [...reasoning.matchAll(HEADING)].findLast((match) => match[1]!.trim() !== "");
  if (heading) return heading[1]!.trim();

  const pieces = reasoning
    .split(/\r?\n/u)
    .flatMap((line) => line.split(SENTENCE_BOUNDARY))
    .map((piece) => piece.trim().replace(LIST_MARKER, ""));
  const streaming = options?.complete === true ? -1 : pieces.length - 1;
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    const minLength = index === streaming ? STREAMING_PIECE_MIN_LENGTH : MIN_REASONING_PIECE_LENGTH;
    if (piece.length >= minLength && isProse(piece)) return piece;
  }
  return undefined;
}

function isProse(piece: string): boolean {
  return !piece.startsWith("```") && /\p{L}/u.test(piece);
}
