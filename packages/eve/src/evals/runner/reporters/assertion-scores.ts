import type { AssertionResult } from "#evals/types.js";

/**
 * The name an assertion is exported under. Gates carry a `gate:` prefix so
 * they do not share a column with a soft assertion of the same name, and so
 * experiments diff gate regressions the same way they diff soft scores.
 * Sinks with stricter label rules normalize this name themselves.
 */
export function exportedAssertionName(assertion: AssertionResult): string {
  return assertion.severity === "gate" ? `gate:${assertion.name}` : assertion.name;
}

/** Assertions reported under one name, scored together. */
export interface AssertionScoreGroup {
  /** Lowest completed score in the group; absent when every member errored. */
  readonly score: number | undefined;
  readonly assertions: readonly AssertionResult[];
}

/**
 * Groups an eval's assertions by reported name and scores each group by its lowest member.
 *
 * Repeated assertions, such as several unlabeled judges, share a name. The minimum keeps one
 * comparable score per name, and a group passes only when every member does.
 */
export function groupAssertionScores(
  assertions: readonly AssertionResult[],
  getName: (assertion: AssertionResult) => string,
): Map<string, AssertionScoreGroup> {
  const groups = new Map<string, AssertionScoreGroup>();
  for (const assertion of assertions) {
    const name = getName(assertion);
    const group = groups.get(name);
    groups.set(name, {
      score: minScore(group?.score, assertion.score),
      assertions: [...(group?.assertions ?? []), assertion],
    });
  }
  return groups;
}

/** Per-assertion scores retained in row metadata once repeated assertions share one score. */
export function composeAssertionScoreMetadata(assertions: readonly AssertionResult[]) {
  return assertions.map(({ key, name, severity, score }) => ({ key, name, severity, score }));
}

function minScore(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.min(current, next);
}
