/**
 * Pure line diffing for the write block's rail. The TUI computes diffs
 * client-side from content it has already seen (write inputs, full-file read
 * results) — putting prior content into the tool's output would feed it
 * straight back into model context, paying tokens for something only the
 * terminal needs.
 */

import { diffLines } from "#shared/line-diff.js";

/** One rail row under a tool header. `kind` is unset for plain/context text. */
export interface ToolDetailLine {
  readonly text: string;
  readonly kind?: "added" | "removed" | "gap";
}

/** Unchanged lines kept around each hunk so a change reads in place. */
const HUNK_CONTEXT_LINES = 2;

/**
 * Builds the write rail for `content` against what it replaced.
 *
 * - `previous` known → a windowed line diff (changes with two context lines,
 *   unchanged stretches collapsed behind `gap` rows); identical content
 *   yields no rows.
 * - `previous` unknown but the file provably did not exist → every line is
 *   an addition.
 * - otherwise → plain content rows, because inventing `+` markers for an
 *   overwrite would misread as "everything changed".
 */
export function diffWriteDetail(
  previous: string | undefined,
  content: string,
  existed?: boolean,
): ToolDetailLine[] {
  const nextLines = splitContentLines(content);
  if (previous === undefined) {
    if (existed === false) {
      return nextLines.map((text) => ({ text, kind: "added" }));
    }
    return nextLines.map((text) => ({ text }));
  }

  const diff = diffLines(splitContentLines(previous), nextLines);
  return diff === undefined ? nextLines.map((text) => ({ text })) : windowHunks(diff);
}

/**
 * Trailing newlines and blank lines are not rail rows: the region shows what
 * the file says, and empty tail rows only push the corner away from it.
 */
function splitContentLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

/**
 * Keeps each change with {@link HUNK_CONTEXT_LINES} unchanged lines around
 * it and collapses longer unchanged stretches into one `gap` row. A diff
 * with no changes windows down to nothing.
 */
function windowHunks(lines: readonly ToolDetailLine[]): ToolDetailLine[] {
  const changed = lines.map((line) => line.kind === "added" || line.kind === "removed");
  if (!changed.includes(true)) return [];

  const keep = lines.map((_, index) => {
    for (
      let probe = Math.max(0, index - HUNK_CONTEXT_LINES);
      probe <= Math.min(lines.length - 1, index + HUNK_CONTEXT_LINES);
      probe += 1
    ) {
      if (changed[probe]) return true;
    }
    return false;
  });

  const windowed: ToolDetailLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (keep[index]) {
      windowed.push(line);
    } else if (windowed.at(-1)?.kind !== "gap") {
      windowed.push({ text: "", kind: "gap" });
    }
  }
  return windowed;
}
