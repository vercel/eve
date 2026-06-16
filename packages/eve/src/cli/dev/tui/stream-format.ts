/**
 * Pure helpers shared by the terminal renderer: key parsing and status-text
 * formatting. Kept apart from the renderer so the presentation class stays
 * focused on painting.
 */

import type { AssistantResponseStatsMode } from "./types.js";

export type TerminalKey =
  | { type: "character"; value: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "enter" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "tab" }
  | { type: "escape" }
  | { type: "ctrl-a" }
  | { type: "ctrl-e" }
  | { type: "ctrl-d" }
  | { type: "ctrl-k" }
  | { type: "ctrl-u" }
  | { type: "ctrl-w" }
  | { type: "ctrl-l" }
  | { type: "ctrl-r" }
  | { type: "ctrl-c" }
  | { type: "ignore" };

/** One decoded key plus how many bytes it consumed from the input buffer. */
export interface KeyToken {
  key?: TerminalKey;
  consumed: number;
  /** The buffer ends mid-sequence; wait for more bytes before decoding. */
  incomplete?: boolean;
}

// Final byte of a CSI escape sequence (`ESC [ … <final>`), range 0x40–0x7e.
const CSI_FINAL = /[\u0040-\u007e]/u;

/** Removes C0 control characters and DEL from text intended for the prompt. */
export function stripPromptControlCharacters(text: string): string {
  let printable = "";
  for (const character of text) {
    if (character >= " " && character !== "\x7f") {
      printable += character;
    }
  }
  return printable;
}

/**
 * Decodes the next key from a raw input buffer, returning how many characters
 * it consumed so a caller can reassemble escape sequences that arrive split
 * across reads (common with PTYs and under load). Returns `incomplete` when the
 * buffer holds only a prefix of a longer sequence (a lone `ESC`, or a CSI/SS3
 * without its final byte) so the caller can wait for the rest.
 */
export function nextKey(buffer: string): KeyToken {
  const first = buffer[0];
  if (first === undefined) return { consumed: 0, incomplete: true };

  if (first === "\x1B") {
    if (buffer.length === 1) return { consumed: 0, incomplete: true };
    const second = buffer[1];
    if (second === "O") {
      // SS3: `ESC O <final>` — needs exactly one more byte.
      if (buffer.length < 3) return { consumed: 0, incomplete: true };
      return { key: parseKey(Buffer.from(buffer.slice(0, 3))), consumed: 3 };
    }
    if (second === "[") {
      for (let i = 2; i < buffer.length; i += 1) {
        if (CSI_FINAL.test(buffer[i]!)) {
          return { key: parseKey(Buffer.from(buffer.slice(0, i + 1))), consumed: i + 1 };
        }
      }
      return { consumed: 0, incomplete: true };
    }
    // `ESC` + another byte (e.g. Alt+key): surface the Escape and re-tokenize.
    return { key: { type: "escape" }, consumed: 1 };
  }

  // A control character is always its own key.
  if (first < " " || first === "\x7F") {
    return { key: parseKey(Buffer.from(first)), consumed: 1 };
  }

  // Otherwise consume the maximal printable run (a typed char or a paste) up to
  // the next control byte or escape.
  let end = 1;
  while (end < buffer.length) {
    const char = buffer[end]!;
    if (char === "\x1B" || char < " " || char === "\x7F") break;
    end += 1;
  }
  return { key: parseKey(Buffer.from(buffer.slice(0, end))), consumed: end };
}

export function parseKey(chunk: Buffer): TerminalKey {
  const value = chunk.toString("utf8");

  switch (value) {
    case "\u0001":
      return { type: "ctrl-a" };
    case "\u0005":
      return { type: "ctrl-e" };
    case "\u0004":
      return { type: "ctrl-d" };
    case "\u000b":
      return { type: "ctrl-k" };
    case "\u000c":
      return { type: "ctrl-l" };
    case "\u0012":
      return { type: "ctrl-r" };
    case "\u0015":
      return { type: "ctrl-u" };
    case "\u0017":
      return { type: "ctrl-w" };
    case "\u0003":
      return { type: "ctrl-c" };
    case "\r":
    case "\n":
      return { type: "enter" };
    case "\u007f":
    case "\b":
      return { type: "backspace" };
    case "\x1B[A":
    case "\x1BOA":
      return { type: "up" };
    case "\x1B[B":
    case "\x1BOB":
      return { type: "down" };
    case "\x1B[C":
    case "\x1BOC":
      return { type: "right" };
    case "\x1B[D":
    case "\x1BOD":
      return { type: "left" };
    case "\x1B[H":
    case "\x1BOH":
    case "\x1B[1~":
      return { type: "home" };
    case "\x1B[F":
    case "\x1BOF":
    case "\x1B[4~":
      return { type: "end" };
    case "\x1B[3~":
      return { type: "delete" };
    case "\t":
      return { type: "tab" };
    case "\x1B":
      return { type: "escape" };
    default: {
      // Strip C0 control characters and DEL so pasted text — which arrives as
      // one batched chunk that may carry newlines/tabs — inserts cleanly
      // instead of injecting literal control bytes into the line.
      const printable = stripPromptControlCharacters(value);
      return printable.length > 0 ? { type: "character", value: printable } : { type: "ignore" };
    }
  }
}

export interface AssistantResponseStats {
  totalTokens: number | undefined;
  outputTokens: number | undefined;
  tokensPerSecond: number | undefined;
}

export async function* takeUntil<T>(
  source: AsyncIterable<T>,
  stop: Promise<void>,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  const stopped = stop.then(
    () => ({ done: true, value: undefined as T }) satisfies IteratorResult<T>,
  );

  try {
    while (true) {
      const next = iterator.next();
      // When `stop` wins the race, this in-flight pull settles later — e.g.
      // rejecting once the caller aborts the underlying stream. Absorb that
      // so it cannot surface as an unhandled rejection after we stopped.
      void next.catch(() => {});
      const nextValue = await Promise.race([next, stopped]);
      if (nextValue.done) break;
      yield nextValue.value;
    }
  } finally {
    // Release the source iterator on every exit path (stop, consumer break,
    // error) so abandoned generators run their cleanup — e.g. the client
    // event stream advancing its session cursor. For generator sources this
    // resolves only once the pending pull settles, so callers that stop
    // mid-pull must also abort the underlying stream (the renderer's Ctrl+C
    // path fires `result.abort()` for exactly this reason).
    void iterator.return?.()?.catch(() => {});
  }
}

/** `394.4K`-style compact count: plain below 1000, then K/M with one trimmed decimal. */
export function formatCompactTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  const scaled = count < 1_000_000 ? count / 1000 : count / 1_000_000;
  const suffix = count < 1_000_000 ? "K" : "M";
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

/**
 * The status line's token-flow segment: `↑ 394.4K ↓ 4.3K`, input (prompt)
 * tokens up, output tokens down, both from the latest usage report. A known
 * `--context-size` appends the context-fill percentage of the input side.
 */
export function formatTokenFlow(
  flow: { inputTokens: number; outputTokens: number; contextSize?: number },
  glyph: { arrowUp: string; arrowDown: string },
): string {
  const up = formatCompactTokenCount(flow.inputTokens);
  const down = formatCompactTokenCount(flow.outputTokens);
  const base = `${glyph.arrowUp} ${up} ${glyph.arrowDown} ${down}`;
  const percentage = formatContextPercentage(flow.inputTokens, flow.contextSize);
  return percentage == null ? base : `${base} ${percentage}`;
}

function formatContextPercentage(
  tokens: number,
  contextSize: number | undefined,
): string | undefined {
  if (contextSize == null || contextSize <= 0 || !Number.isFinite(contextSize)) {
    return undefined;
  }
  return `${Math.round((tokens / contextSize) * 100).toLocaleString()}%`;
}

export function formatAssistantResponseStats(
  stats: AssistantResponseStats,
  mode: AssistantResponseStatsMode,
): string | undefined {
  if (mode === "tokensPerSecond") {
    return formatTokensPerSecond(stats.tokensPerSecond);
  }
  // Label output tokens explicitly — the persistent status line below this
  // row already shows the total token count.
  if (stats.outputTokens == null) return undefined;
  return `${stats.outputTokens.toLocaleString()} output tokens`;
}

function formatTokensPerSecond(tokensPerSecond: number | undefined): string | undefined {
  if (tokensPerSecond == null) return undefined;
  return `${formatNumber(tokensPerSecond)} tok/s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
