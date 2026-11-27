export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  const needle = name.toLowerCase();
  const maxDistance = needle.length <= 4 ? 1 : 2;
  let best: { readonly candidate: string; readonly distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance <= maxDistance && (best === undefined || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length]!;
}
