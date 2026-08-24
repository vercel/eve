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
  /** The `@workflow/core` version this eve release bundles. */
  readonly expectedWorkflowVersion: string;
}

export interface ValidatedWorkflowWorldCompatibility {
  readonly declaredPackageName: (typeof WORKFLOW_COMPATIBILITY_PACKAGES)[number];
  readonly declaredRange: string;
  readonly expectedVersion: string;
}

interface VersionLine {
  readonly major: number;
  readonly prereleaseTag: string | undefined;
}

/**
 * Parses the leading semver-ish coordinates out of a version or simple range.
 *
 * This is intentionally tiny: eve only needs the major number and any
 * prerelease tag to detect a definite line mismatch, so we avoid pulling in a
 * full semver parser.
 */
function parseVersionLine(value: string): VersionLine | undefined {
  const match = /(\d+)\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());

  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);

  if (!Number.isInteger(major)) {
    return undefined;
  }

  const prerelease = match[2];
  const prereleaseTag = prerelease === undefined ? undefined : prerelease.split(".")[0];

  return { major, prereleaseTag };
}

function readDeclaredWorkflowDependency(manifest: WorkflowWorldManifest):
  | {
      packageName: (typeof WORKFLOW_COMPATIBILITY_PACKAGES)[number];
      range: string;
    }
  | undefined {
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
 */
export function assertWorkflowWorldCompatibility(
  input: AssertWorkflowWorldCompatibilityInput,
): ValidatedWorkflowWorldCompatibility {
  const declared = readDeclaredWorkflowDependency(input.worldManifest);

  if (declared === undefined) {
    throw new Error(
      `Configured Workflow world "${input.worldPackageName}" must declare a dependency or peerDependency on @workflow/core or @workflow/world so eve can validate its protocol line.`,
    );
  }

  const worldLine = parseVersionLine(declared.range);
  const expectedLine = parseVersionLine(input.expectedWorkflowVersion);

  if (worldLine === undefined) {
    throw new Error(
      `Configured Workflow world "${input.worldPackageName}" declares ${declared.packageName} with unsupported range ${JSON.stringify(declared.range)}. Use a semver range that identifies its Workflow protocol line.`,
    );
  }
  if (expectedLine === undefined) {
    throw new Error(
      `eve cannot validate configured Workflow world "${input.worldPackageName}" because its bundled Workflow version ${JSON.stringify(input.expectedWorkflowVersion)} is invalid.`,
    );
  }

  if (!isDefiniteLineMismatch(worldLine, expectedLine)) {
    return {
      declaredPackageName: declared.packageName,
      declaredRange: declared.range,
      expectedVersion: input.expectedWorkflowVersion,
    };
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
