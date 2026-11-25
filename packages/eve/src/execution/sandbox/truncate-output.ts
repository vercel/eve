export const MAX_OUTPUT_LINES = 2000;

export const MAX_OUTPUT_BYTES = 50 * 1024;

export const MAX_LINE_LENGTH = 2000;

const LINE_TRUNCATION_SUFFIX = " [truncated]";

interface TruncationResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly lineTruncated: boolean;
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
  if (text.length === 0) {
    return {
      output: "",
      outputLines: 0,
      totalLines: 0,
      truncated: false,
      lineTruncated: false,
    };
  }
  const rawLines = text.split("\n");
  const hasTrailingNewline = rawLines[rawLines.length - 1] === "";
  const logicalLines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;
  const totalLines = logicalLines.length;
  const fromStart = direction === "head";

  const kept: string[] = [];
  let bytes = 0;
  let lineTruncated = false;

  const start = fromStart ? 0 : logicalLines.length - 1;
  const step = fromStart ? 1 : -1;

  for (
    let i = start;
    i >= 0 && i < logicalLines.length && kept.length < MAX_OUTPUT_LINES;
    i += step
  ) {
    const rawLine = logicalLines[i] ?? "";
    if (rawLine.length > MAX_LINE_LENGTH) {
      lineTruncated = true;
    }
    const line = capLineLength(rawLine);
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

  const truncated = kept.length < totalLines;
  const preserveTrailingNewline = hasTrailingNewline && (!fromStart || !truncated);
  const output = kept.join("\n") + (preserveTrailingNewline ? "\n" : "");

  return {
    output,
    outputLines: kept.length,
    totalLines,
    truncated,
    lineTruncated,
  };
}

export function capLineLength(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}
