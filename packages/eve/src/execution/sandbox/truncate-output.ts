export const MAX_OUTPUT_LINES = 2000;

export const MAX_OUTPUT_BYTES = 50 * 1024;

export const MAX_LINE_LENGTH = 2000;

const LINE_TRUNCATION_SUFFIX = " [truncated]";

interface TruncationResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly totalLines: number;
  readonly outputLines: number;
}

export function truncateHead(text: string): TruncationResult {
  return truncateByDirection(text, "head");
}

export function truncateTail(text: string): TruncationResult {
  return truncateByDirection(text, "tail");
}

function truncateByDirection(text: string, direction: "head" | "tail"): TruncationResult {
  const rawLines = text.split("\n");
  const totalLines = countLogicalLines(rawLines);
  const fromStart = direction === "head";

  const kept: string[] = [];
  let bytes = 0;

  const start = fromStart ? 0 : rawLines.length - 1;
  const step = fromStart ? 1 : -1;

  for (let i = start; i >= 0 && i < rawLines.length && kept.length < MAX_OUTPUT_LINES; i += step) {
    const line = capLineLength(rawLines[i] ?? "");
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;

    if (bytes + lineBytes > MAX_OUTPUT_BYTES && kept.length > 0) {
      break;
    }

    kept.push(line);
    bytes += lineBytes;
  }

  if (!fromStart) {
    kept.reverse();
  }

  return {
    output: kept.join("\n"),
    outputLines: kept.length,
    totalLines,
    truncated: kept.length < totalLines,
  };
}

export function capLineLength(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}

function countLogicalLines(lines: readonly string[]): number {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
}
