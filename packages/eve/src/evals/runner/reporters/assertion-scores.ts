import type { AssertionResult } from "#evals/types.js";

/** Assertions reported under one name, scored together. */
export interface AssertionScoreGroup {
  readonly score: number;
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
      score: Math.min(group?.score ?? assertion.score, assertion.score),
      assertions: [...(group?.assertions ?? []), assertion],
    });
  }
  return groups;
}

/** Per-assertion scores retained in row metadata once repeated assertions share one score. */
export function composeAssertionScoreMetadata(assertions: readonly AssertionResult[]) {
  return assertions.map(({ name, severity, score }) => ({ name, severity, score }));
}
