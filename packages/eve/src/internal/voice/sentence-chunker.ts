/**
 * Splits a stream of assistant text deltas into speakable chunks on sentence
 * boundaries.
 *
 * Gateway text-to-speech is batch, not streaming, so the voice channel
 * synthesizes one sentence at a time as the agent produces text. That lets
 * playback of the first sentence start while the model is still writing later
 * ones, instead of waiting for the whole reply.
 *
 * Feed deltas with {@link SentenceChunker.push} and speak each returned chunk;
 * call {@link SentenceChunker.flush} once the turn completes to emit any
 * trailing text that never hit a sentence boundary.
 */
export interface SentenceChunker {
  /**
   * Appends a text delta and returns any newly completed speakable chunks. A
   * delta that does not complete a sentence returns an empty array and is
   * buffered until a later delta (or {@link SentenceChunker.flush}) closes it.
   */
  push(delta: string): string[];
  /** Returns and clears any buffered remainder, or `null` when empty. */
  flush(): string | null;
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);
const CLOSING_MARKS = new Set(['"', "'", ")", "]", "”", "’"]);

/**
 * Creates a {@link SentenceChunker}.
 *
 * A sentence boundary is a terminator (`.`, `!`, `?`, `…`), optionally followed
 * by closing quotes/brackets, then whitespace — requiring the trailing
 * whitespace keeps decimals like `3.14` and unspaced abbreviations intact. A
 * newline is always treated as a boundary. Chunks shorter than
 * `minChunkLength` (after trimming) are held back and merged into the next one
 * so single stray characters are not spoken on their own.
 */
export function createSentenceChunker(options: { minChunkLength?: number } = {}): SentenceChunker {
  const minChunkLength = options.minChunkLength ?? 2;
  let buffer = "";

  const push = (delta: string): string[] => {
    buffer += delta;
    const chunks: string[] = [];
    let start = 0;
    let index = 0;

    while (index < buffer.length) {
      const char = buffer[index] ?? "";
      const isNewline = char === "\n";
      const isTerminator = SENTENCE_TERMINATORS.has(char);

      if (!isNewline && !isTerminator) {
        index += 1;
        continue;
      }

      let boundary = index + 1;
      if (isTerminator) {
        while (boundary < buffer.length && CLOSING_MARKS.has(buffer[boundary] ?? "")) boundary += 1;
        // Need to see the character after the terminator to know it is a real
        // boundary (whitespace) and not a decimal/abbreviation. If it is the
        // end of the buffer, wait for the next delta.
        if (boundary >= buffer.length) break;
        if (!/\s/.test(buffer[boundary] ?? "")) {
          index = boundary;
          continue;
        }
      }

      const candidate = buffer.slice(start, boundary).trim();
      if (candidate.length >= minChunkLength) {
        chunks.push(candidate);
        while (boundary < buffer.length && /\s/.test(buffer[boundary] ?? "")) boundary += 1;
        start = boundary;
        index = boundary;
      } else {
        // Too short to speak alone — keep scanning so it merges into the next
        // sentence.
        index = boundary;
      }
    }

    buffer = buffer.slice(start);
    return chunks;
  };

  const flush = (): string | null => {
    const remainder = buffer.trim();
    buffer = "";
    return remainder.length > 0 ? remainder : null;
  };

  return { push, flush };
}
