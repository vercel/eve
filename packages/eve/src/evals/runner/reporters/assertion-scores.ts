import type { AssertionResult } from "#evals/types.js";

export function exportedAssertionName(assertion: AssertionResult): string {
  const name = assertion.key ?? assertion.name;
  return assertion.severity === "gate" ? `gate:${name}` : name;
}

export interface AssertionScoreGroup {
  readonly score: number | undefined;
  readonly assertions: readonly AssertionResult[];
}

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

export function composeAssertionScoreMetadata(assertions: readonly AssertionResult[]) {
  return assertions.map(({ key, name, severity, score }) => ({ key, name, severity, score }));
}

function minScore(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.min(current, next);
}
