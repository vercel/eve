import type { AssistantResponseStatsMode } from "./types.js";

export type TerminalKey =
  | {
      type: "text";
      value: string;
      framing: "unframed" | "bracketed-paste";
    }
  | { type: "newline" }
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
  | {
      type: "mouse";
      action: "press" | "release";
      button: number;
      x: number;
      y: number;
    }
  | { type: "ctrl-a" }
  | { type: "ctrl-b" }
  | { type: "ctrl-e" }
  | { type: "ctrl-f" }
  | { type: "ctrl-d" }
  | { type: "alt-b" }
  | { type: "alt-f" }
  | { type: "alt-backspace" }
  | { type: "alt-y" }
  | { type: "ctrl-k" }
  | { type: "ctrl-n" }
  | { type: "ctrl-p" }
  | { type: "ctrl-u" }
  | { type: "ctrl-w" }
  | { type: "ctrl-y" }
  | { type: "ctrl-l" }
  | { type: "ctrl-r" }
  | { type: "ctrl-c" }
  | {
      type: "osc";
      value: string;
    }
  | { type: "ignore" };

interface KeyToken {
  key?: TerminalKey;
  consumed: number;
  incomplete?: boolean;
}

const CSI_FINAL = /[\u0040-\u007e]/u;

const PASTE_START = "\x1B[200~";
const PASTE_END = "\x1B[201~";

export function sanitizePastedText(text: string): string {
  let printable = "";
  for (const character of text.replace(/\r\n?/gu, "\n")) {
    if (character === "\n" || character === "\t") {
      printable += character;
      continue;
    }
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    printable += character;
  }
  return printable;
}

export function isIncompletePaste(buffer: string): boolean {
  return buffer.startsWith(PASTE_START) && !buffer.includes(PASTE_END, PASTE_START.length);
}

export function stripPasteStart(buffer: string): string {
  return buffer.startsWith(PASTE_START) ? buffer.slice(PASTE_START.length) : buffer;
}

export function isIncompleteOsc(buffer: string): boolean {
  return buffer.startsWith("\x1b]") && !buffer.includes("\x07", 2) && !buffer.includes("\x1b\\", 2);
}

export function stripPromptControlCharacters(text: string): string {
  let printable = "";
  for (const character of text) {
    if (character >= " " && character !== "\x7f") {
      printable += character;
    }
  }
  return printable;
}

export function nextKey(buffer: string): KeyToken {
  const first = buffer[0];
  if (first === undefined) return { consumed: 0, incomplete: true };

  if (first === "\x1B") {
    if (buffer.length === 1) return { consumed: 0, incomplete: true };
    const second = buffer[1];
    if (second === "O") {
      if (buffer.length < 3) return { consumed: 0, incomplete: true };
      return { key: parseKey(Buffer.from(buffer.slice(0, 3))), consumed: 3 };
    }
    if (second === "[") {
      if (buffer.startsWith(PASTE_START)) {
        const end = buffer.indexOf(PASTE_END, PASTE_START.length);
        if (end === -1) return { consumed: 0, incomplete: true };
        return {
          key: {
            type: "text",
            value: sanitizePastedText(buffer.slice(PASTE_START.length, end)),
            framing: "bracketed-paste",
          },
          consumed: end + PASTE_END.length,
        };
      }
      for (let i = 2; i < buffer.length; i += 1) {
        if (CSI_FINAL.test(buffer[i]!)) {
          return { key: parseKey(Buffer.from(buffer.slice(0, i + 1))), consumed: i + 1 };
        }
      }
      return { consumed: 0, incomplete: true };
    }
    if (second === "]") {
      const bel = buffer.indexOf("\x07", 2);
      const st = buffer.indexOf("\x1b\\", 2);
      if (bel === -1 && st === -1) return { consumed: 0, incomplete: true };
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      return {
        key: { type: "osc", value: buffer.slice(2, end) },
        consumed: end + (end === bel ? 1 : 2),
      };
    }
    if (second === "b" || second === "B") {
      return { key: { type: "alt-b" }, consumed: 2 };
    }
    if (second === "f" || second === "F") {
      return { key: { type: "alt-f" }, consumed: 2 };
    }
    if (second === "y" || second === "Y") {
      return { key: { type: "alt-y" }, consumed: 2 };
    }
    if (second === "\x7f" || second === "\b") {
      return { key: { type: "alt-backspace" }, consumed: 2 };
    }
    return { key: { type: "escape" }, consumed: 1 };
  }

  if (first < " " || first === "\x7F") {
    return { key: parseKey(Buffer.from(first)), consumed: 1 };
  }

  let end = 1;
  while (end < buffer.length) {
    const char = buffer[end]!;
    if (char === "\x1B" || char < " " || char === "\x7F") break;
    end += 1;
  }
  return { key: parseKey(Buffer.from(buffer.slice(0, end))), consumed: end };
}

const SGR_MOUSE = new RegExp(`^${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`, "u");

export function parseKey(chunk: Buffer): TerminalKey {
  const value = chunk.toString("utf8");

  const mouse = SGR_MOUSE.exec(value);
  if (mouse !== null) {
    return {
      type: "mouse",
      action: mouse[4] === "M" ? "press" : "release",
      button: Number(mouse[1]),
      x: Number(mouse[2]),
      y: Number(mouse[3]),
    };
  }

  switch (value) {
    case "\u0001":
      return { type: "ctrl-a" };
    case "\u0002":
      return { type: "ctrl-b" };
    case "\u0005":
      return { type: "ctrl-e" };
    case "\u0006":
      return { type: "ctrl-f" };
    case "\u0004":
      return { type: "ctrl-d" };
    case "\u000b":
      return { type: "ctrl-k" };
    case "\u000e":
      return { type: "ctrl-n" };
    case "\u0010":
      return { type: "ctrl-p" };
    case "\u000c":
      return { type: "ctrl-l" };
    case "\u0012":
      return { type: "ctrl-r" };
    case "\u0015":
      return { type: "ctrl-u" };
    case "\u0017":
      return { type: "ctrl-w" };
    case "\u0019":
      return { type: "ctrl-y" };
    case "\u0003":
      return { type: "ctrl-c" };
    case "\r":
      return { type: "enter" };
    case "\n":
    case "\x1b[27;2;13~":
    case "\x1b[13;2u":
      return { type: "newline" };
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
    case "\x1B[1;3C":
    case "\x1B[1;5C":
    case "\x1B[5C":
      return { type: "alt-f" };
    case "\x1B[1;3D":
    case "\x1B[1;5D":
    case "\x1B[5D":
      return { type: "alt-b" };
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
    case "\x1B[127;3u":
    case "\x1B[8;3u":
    case "\x1B[27;3;127~":
    case "\x1B[27;3;8~":
      return { type: "alt-backspace" };
    case "\t":
      return { type: "tab" };
    case "\x1B":
      return { type: "escape" };
    default: {
      const printable = stripPromptControlCharacters(value);
      return printable.length > 0
        ? { type: "text", value: printable, framing: "unframed" }
        : { type: "ignore" };
    }
  }
}

interface AssistantResponseStats {
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
      void next.catch(() => {});
      const nextValue = await Promise.race([next, stopped]);
      if (nextValue.done) break;
      yield nextValue.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => {});
  }
}

export function formatCompactTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  const scaled = count < 1_000_000 ? count / 1000 : count / 1_000_000;
  const suffix = count < 1_000_000 ? "K" : "M";
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

export function formatTurnDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return seconds === 0 ? `${minutes}min` : `${minutes}min ${seconds}s`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}

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
