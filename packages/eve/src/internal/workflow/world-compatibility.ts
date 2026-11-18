const WORKFLOW_COMPATIBILITY_PACKAGES = ["@workflow/core", "@workflow/world"] as const;

export interface WorkflowWorldManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface AssertWorkflowWorldCompatibilityInput {
  readonly worldPackageName: string;
  readonly worldManifest: WorkflowWorldManifest;
  readonly expectedWorkflowVersion: string;
}

interface VersionLine {
  readonly major: number;
  readonly prereleaseTag: string | undefined;
}

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
