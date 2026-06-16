/**
 * Shared output truncation utilities for framework tool executors.
 *
 * Every framework tool that can return unbounded text output (bash,
 * grep, glob, read_file, web_fetch) uses these helpers to enforce
 * consistent size limits inside its executor before the result enters
 * conversation history. Authored tools are expected to do the same —
 * bounding at the source keeps the contract simple: whatever `execute`
 * returns is what the model sees.
 */

/**
 * Maximum number of lines kept after truncation.
 */
export const MAX_OUTPUT_LINES = 2000;

/**
 * Maximum byte size of the truncated output.
 */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Maximum length of a single line before it is truncated.
 */
export const MAX_LINE_LENGTH = 2000;

/**
 * Suffix appended to lines exceeding {@link MAX_LINE_LENGTH}.
 */
export const LINE_TRUNCATION_SUFFIX = " [truncated]";

/**
 * Result of a {@link truncateTail} or {@link truncateHead} call.
 */
export interface TruncationResult {
  /** The truncated output text. */
  readonly output: string;
  /** True when the output was shortened. */
  readonly truncated: boolean;
  /** Total number of lines in the original input. */
  readonly totalLines: number;
  /** Number of lines included in the truncated output. */
  readonly outputLines: number;
}

/**
 * Keeps the **first** lines of `text` that fit within the line and byte
 * budgets. This is the default shape of tool-result truncation — most
 * tool output (file contents, grep results, web fetches) is more
 * informative at the beginning.
 *
 * Each included line is individually capped at {@link MAX_LINE_LENGTH}
 * characters. Iteration starts from the beginning and stops when either
 * the line count reaches {@link MAX_OUTPUT_LINES} or cumulative byte
 * size would exceed {@link MAX_OUTPUT_BYTES}.
 */
export function truncateHead(text: string): TruncationResult {
  return truncateByDirection(text, "head");
}

/**
 * Keeps the **last** lines of `text` that fit within the line and byte
 * budgets. Useful for bash output where errors and results appear at
 * the end.
 *
 * Each included line is individually capped at {@link MAX_LINE_LENGTH}
 * characters. Iteration starts from the end and stops when either the
 * line count reaches {@link MAX_OUTPUT_LINES} or cumulative byte size
 * would exceed {@link MAX_OUTPUT_BYTES}.
 */
export function truncateTail(text: string): TruncationResult {
  return truncateByDirection(text, "tail");
}

/**
 * Shared truncation loop used by {@link truncateHead} and
 * {@link truncateTail}. The only difference between the two is the
 * iteration direction; all other budgeting logic is identical.
 */
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

/**
 * Caps a single line at {@link MAX_LINE_LENGTH} characters, appending
 * {@link LINE_TRUNCATION_SUFFIX} when truncated.
 *
 * Exported for tools that build their own output line-by-line (e.g.
 * `read_file` prepends line numbers, `grep` counts matches) so they
 * share the same per-line cap as {@link truncateHead} / {@link truncateTail}
 * without re-implementing the slice+suffix pattern.
 */
export function capLineLength(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}

/**
 * Counts logical lines, treating a trailing empty element from
 * `split("\n")` as not a separate line (consistent with read-file-tool).
 */
function countLogicalLines(lines: readonly string[]): number {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
}
