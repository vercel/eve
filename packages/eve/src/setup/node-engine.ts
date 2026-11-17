import semver from "#compiled/semver/index.js";

const { Range, intersects, minVersion, subset, validRange } = semver;

export interface NodeEngineOverride {
  previous: unknown;
  next: string;
}

export type NodeEngineReconciliation =
  | { kind: "added"; next: string }
  | ({ kind: "overridden" } & NodeEngineOverride)
  | { kind: "unchanged" };

function isNonEmptySubset(candidateRange: string, requiredRange: string): boolean {
  const normalizedCandidate = validRange(candidateRange);
  return (
    normalizedCandidate !== null &&
    intersects(normalizedCandidate, requiredRange) &&
    subset(normalizedCandidate, requiredRange)
  );
}

function nextAllowedMajor(requiredRange: string, currentMajor: number): number | undefined {
  const lowerBound = `>=${currentMajor + 1}.0.0`;
  let nextMajor: number | undefined;

  for (const comparatorSet of new Range(requiredRange).set) {
    const constrainedRange = [
      ...comparatorSet.map((comparator) => comparator.value).filter(Boolean),
      lowerBound,
    ].join(" ");
    const nextVersion = minVersion(constrainedRange);
    if (nextVersion !== null && (nextMajor === undefined || nextVersion.major < nextMajor)) {
      nextMajor = nextVersion.major;
    }
  }

  return nextMajor;
}

export function pinnedNodeEngineMajor(requiredRange: string): string {
  const normalized = validRange(requiredRange);
  if (normalized === null) {
    throw new Error(`eve declares an invalid Node.js engine range: "${requiredRange}".`);
  }
  const floor = minVersion(normalized);
  if (floor === null) {
    throw new Error(`eve declares an empty Node.js engine range: "${requiredRange}".`);
  }

  let candidateMajor: number | undefined = floor.major;
  while (candidateMajor !== undefined) {
    const pinnedRange = `${candidateMajor}.x`;
    if (isNonEmptySubset(pinnedRange, normalized)) {
      return pinnedRange;
    }
    candidateMajor = nextAllowedMajor(normalized, candidateMajor);
  }

  throw new Error(
    `eve's Node.js engine range "${requiredRange}" cannot be represented by a major pin without widening it.`,
  );
}

export function reconcileNodeEngine(
  existingValue: unknown,
  requiredRange: string,
): NodeEngineReconciliation {
  const pinnedRange = pinnedNodeEngineMajor(requiredRange);
  if (existingValue === undefined) {
    return { kind: "added", next: pinnedRange };
  }
  if (typeof existingValue === "string" && isNonEmptySubset(existingValue, pinnedRange)) {
    return { kind: "unchanged" };
  }
  return {
    kind: "overridden",
    previous: existingValue,
    next: pinnedRange,
  };
}

function formatPackageJsonValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

export function formatNodeEngineOverrideWarning(override: NodeEngineOverride): string {
  return (
    `Overrode package.json engines.node from ${formatPackageJsonValue(override.previous)} ` +
    `to "${override.next}" because the previous value was not confined to the Node.js major selected by eve.`
  );
}
