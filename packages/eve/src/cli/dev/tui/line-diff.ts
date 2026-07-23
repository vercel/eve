/**
 * Pure line diffing for the write block's rail. The TUI computes diffs
 * client-side from content it has already seen (write inputs, full-file read
 * results) — putting prior content into the tool's output would feed it
 * straight back into model context, paying tokens for something only the
 * terminal needs.
 */

/** One rail row under a tool header. `kind` is unset for plain/context text. */
export interface ToolDetailLine {
  readonly text: string;
  readonly kind?: "added" | "removed" | "gap";
}

/** Unchanged lines kept around each hunk so a change reads in place. */
const HUNK_CONTEXT_LINES = 2;

/**
 * The LCS table is quadratic; past this many cells the diff is abandoned and
 * the caller falls back to plain content.
 */
const MAX_DIFF_CELLS = 250_000;

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

  const previousLines = splitContentLines(previous);
  if ((previousLines.length + 1) * (nextLines.length + 1) > MAX_DIFF_CELLS) {
    return nextLines.map((text) => ({ text }));
  }

  return windowHunks(lcsDiff(previousLines, nextLines));
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

/** Classic LCS backtrack producing removed-before-added hunks. */
function lcsDiff(a: readonly string[], b: readonly string[]): ToolDetailLine[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const lines: ToolDetailLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      lines.push({ text: a[i]!, kind: "removed" });
      i += 1;
    } else {
      lines.push({ text: b[j]!, kind: "added" });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ text: a[i]!, kind: "removed" });
  for (; j < b.length; j += 1) lines.push({ text: b[j]!, kind: "added" });
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
