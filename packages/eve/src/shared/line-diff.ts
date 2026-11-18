export interface LineDiffEntry {
  readonly text: string;
  readonly kind?: "added" | "removed";
}

const MAX_DIFF_CELLS = 250_000;

export function diffLines(
  before: readonly string[],
  after: readonly string[],
): LineDiffEntry[] | undefined {
  if ((before.length + 1) * (after.length + 1) > MAX_DIFF_CELLS) return undefined;
  const width = after.length + 1;
  const common = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        before[i] === after[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }

  const lines: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ text: before[i]! });
      i += 1;
      j += 1;
    } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
      lines.push({ text: before[i]!, kind: "removed" });
      i += 1;
    } else {
      lines.push({ text: after[j]!, kind: "added" });
      j += 1;
    }
  }
  for (; i < before.length; i += 1) lines.push({ text: before[i]!, kind: "removed" });
  for (; j < after.length; j += 1) lines.push({ text: after[j]!, kind: "added" });
  return lines;
}
