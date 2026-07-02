/**
 * The `@workflow/*` packages whose version line a configured world is checked
 * against, in order of preference. eve compares the world's declared dependency
 * on the first of these it finds.
 */
const WORKFLOW_COMPATIBILITY_PACKAGES = ["@workflow/core", "@workflow/world"] as const;

/**
 * Minimal subset of an npm `package.json` needed to read a world's declared
 * `@workflow/*` dependency line.
 */
export interface WorkflowWorldManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface AssertWorkflowWorldCompatibilityInput {
  /** Package name of the configured world, used only for the error message. */
  readonly worldPackageName: string;
  /** Parsed `package.json` of the installed configured world. */
  readonly worldManifest: WorkflowWorldManifest;
  /** The `@workflow/core` version this eve release bundles (its single source of truth). */
  readonly expectedWorkflowVersion: string;
}

interface VersionLine {
  readonly major: number;
  readonly prereleaseTag: string | undefined;
}

/**
 * Parses the leading semver-ish coordinates out of a version or simple range.
 *
 * This is intentionally tiny — eve only needs the major number and any
 * prerelease tag to detect a definite line mismatch, so we avoid pulling in a
 * full semver parser (keeping `nitro` as eve's only runtime dependency).
 * Returns `undefined` when the major cannot be determined so callers can no-op
 * rather than risk a false-positive boot failure.
 */
function parseVersionLine(value: string): VersionLine | undefined {
  // Strip a single leading range operator (`^`, `~`, `>=`, etc.) and any
  // surrounding whitespace; we only inspect the first concrete version.
  const match = /(\d+)\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());

  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);

  if (!Number.isInteger(major)) {
    return undefined;
  }

  const prerelease = match[2];
  // Reduce `beta.13` / `beta.24` to the line tag `beta` so different patch
  // builds on the same prerelease line compare equal.
  const prereleaseTag = prerelease === undefined ? undefined : prerelease.split(".")[0];

  return { major, prereleaseTag };
}

function readDeclaredWorkflowDependency(
  manifest: WorkflowWorldManifest,
): { packageName: string; range: string } | undefined {
  for (const packageName of WORKFLOW_COMPATIBILITY_PACKAGES) {
    const range = manifest.dependencies?.[packageName] ?? manifest.peerDependencies?.[packageName];

    if (typeof range === "string" && range.trim().length > 0) {
      return { packageName, range };
    }
  }

  return undefined;
}

function isDefiniteLineMismatch(world: VersionLine, expected: VersionLine): boolean {
  if (world.major !== expected.major) {
    return true;
  }

  // Same major: a definite mismatch only when both sides declare a prerelease
  // tag and the tags differ (e.g. `beta` vs `alpha`). A world targeting a
  // stable release of the same major (no prerelease tag) is treated as
  // compatible-enough — we only fail on unambiguous divergence.
  return (
    world.prereleaseTag !== undefined &&
    expected.prereleaseTag !== undefined &&
    world.prereleaseTag !== expected.prereleaseTag
  );
}

function formatExpectedLine(line: VersionLine): string {
  return line.prereleaseTag === undefined
    ? `${String(line.major)}.x`
    : `${String(line.major)}.0.0-${line.prereleaseTag} line`;
}

/**
 * Fails fast when a configured Workflow world targets a `@workflow/*` major or
 * prerelease line that is incompatible with the line this eve release bundles.
 *
 * The check is deliberately conservative: it throws only on a *definite*
 * mismatch (a different major version, or a different prerelease tag on the
 * same major). When the world's declared `@workflow/*` dependency is missing or
 * its version cannot be parsed, this is a no-op so eve never turns an
 * ambiguous-but-possibly-fine setup into a hard boot failure. The deeper,
 * fully version-aware compatibility check belongs in `@workflow/core`; this is
 * a low-risk early signal that surfaces an actionable message instead of a
 * cryptic Zod error deep in workflow replay.
 *
 * @throws Error when the world declares an incompatible `@workflow/*` line.
 */
export function assertWorkflowWorldCompatibility(
  input: AssertWorkflowWorldCompatibilityInput,
): void {
  const declared = readDeclaredWorkflowDependency(input.worldManifest);

  if (declared === undefined) {
    return;
  }

  const worldLine = parseVersionLine(declared.range);
  const expectedLine = parseVersionLine(input.expectedWorkflowVersion);

  if (worldLine === undefined || expectedLine === undefined) {
    return;
  }

  if (!isDefiniteLineMismatch(worldLine, expectedLine)) {
    return;
  }

  const worldLineLabel =
    worldLine.prereleaseTag === undefined
      ? `${String(worldLine.major)}.x`
      : `${String(worldLine.major)}.x (${worldLine.prereleaseTag} line)`;

  throw new Error(
    `Configured Workflow world "${input.worldPackageName}" targets ${declared.packageName} ${worldLineLabel}, ` +
      `but this eve release requires the ${declared.packageName} ${formatExpectedLine(expectedLine)}. ` +
      `Install a matching world, e.g. \`pnpm add ${input.worldPackageName}@${input.expectedWorkflowVersion}\`.`,
  );
}
