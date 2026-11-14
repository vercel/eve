/** A sample's distribution, in the sample's unit. */
export interface Summary {
  readonly n: number;
  readonly median: number;
  readonly p90: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarize(values: readonly number[]): Summary | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    median: round(
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
    ),
    p90: round(percentile(sorted, 90)),
    mean: round(sum / sorted.length),
    min: round(sorted[0]!),
    max: round(sorted.at(-1)!),
  };
}

/** Least-squares slope of `ys` over `xs`: how much y grows per unit of x. */
export function slope(xs: readonly number[], ys: readonly number[]): number | undefined {
  if (xs.length < 2 || xs.length !== ys.length) return undefined;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? undefined : round(num / den, 3);
}

export function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
