import { diffLines } from "#shared/line-diff.js";

export interface ToolDetailLine {
  readonly text: string;
  readonly kind?: "added" | "removed" | "gap";
}

const HUNK_CONTEXT_LINES = 2;

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

function splitContentLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

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
