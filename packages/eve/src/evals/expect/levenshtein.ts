/** Normalized edit similarity using UTF-16 code units, matching string.length. */
export function levenshteinSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < right.length) [left, right] = [right, left];
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(
        above + 1,
        row[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - row[right.length]! / left.length;
}
