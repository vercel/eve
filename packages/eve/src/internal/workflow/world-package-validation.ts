import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import semver from "#compiled/semver/index.js";
import { resolvePackageRoot } from "#internal/application/package.js";

const WORKFLOW_WORLD_PACKAGE_NAME = "@workflow/world";
const EVE_WORKFLOW_WORLD_SUPPORTED_RANGE = ">=5.0.0-0 <6.0.0-0";
const EVE_WORKFLOW_WORLD_SUPPORTED_MAJOR = 5;
interface WorkflowWorldSemverApi {
  readonly validRange: (range: string) => string | null;
  readonly intersects: (
    rangeA: string,
    rangeB: string,
    options?: { readonly includePrerelease?: boolean },
  ) => boolean;
  readonly minVersion: (range: string) => { readonly major: number } | null;
  readonly valid: (version: string) => string | null;
}

const semverApi = semver as WorkflowWorldSemverApi;

interface PackageJson {
  readonly name?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
}

interface VendorStamp {
  readonly moduleVersions?: Record<string, unknown>;
}

interface DeclaredWorkflowWorldDependency {
  readonly kind: "dependency" | "peerDependency";
  readonly range: string;
}

export function validateWorkflowWorldPackage(input: {
  readonly appRoot: string;
  readonly world: string | undefined;
}): void {
  if (input.world === undefined) {
    return;
  }

  const eveWorkflowWorldVersion = resolveEveWorkflowWorldVersion();
  validateVendoredWorkflowWorldVersion(eveWorkflowWorldVersion);
  const packageName = parsePackageName(input.world);
  const packageJsonPath = resolveInstalledPackageJsonPath(input.appRoot, packageName);

  if (packageJsonPath === undefined) {
    throw new Error(
      `Configured Workflow world package "${input.world}" could not be resolved from "${input.appRoot}". Install it in the app before using "experimental.workflow.world".`,
    );
  }

  const packageJson = readPackageJson(packageJsonPath);
  const declaredDependency = resolveDeclaredWorkflowWorldDependency(packageJson);

  if (declaredDependency === undefined) {
    throw new Error(
      `Configured Workflow world package "${input.world}" must declare a dependency or peerDependency on "${WORKFLOW_WORLD_PACKAGE_NAME}" compatible with eve's supported "${WORKFLOW_WORLD_PACKAGE_NAME}" range (${EVE_WORKFLOW_WORLD_SUPPORTED_RANGE}).`,
    );
  }

  if (semverApi.validRange(declaredDependency.range) === null) {
    throw new Error(
      `Configured Workflow world package "${input.world}" declares an invalid "${WORKFLOW_WORLD_PACKAGE_NAME}" ${declaredDependency.kind} range: ${JSON.stringify(declaredDependency.range)}.`,
    );
  }

  if (
    !isDeclaredWorkflowWorldDependencyCompatible({
      declaredDependency,
    })
  ) {
    throw new Error(
      `Configured Workflow world package "${input.world}" declares "${WORKFLOW_WORLD_PACKAGE_NAME}" ${declaredDependency.kind} ${JSON.stringify(declaredDependency.range)}, but eve supports "${WORKFLOW_WORLD_PACKAGE_NAME}" ${EVE_WORKFLOW_WORLD_SUPPORTED_RANGE}. Install a world package version that supports eve's Workflow world dependency.`,
    );
  }
}

function resolveDeclaredWorkflowWorldDependency(
  packageJson: PackageJson,
): DeclaredWorkflowWorldDependency | undefined {
  const peerRange = packageJson.peerDependencies?.[WORKFLOW_WORLD_PACKAGE_NAME];

  if (typeof peerRange === "string" && peerRange.trim() !== "") {
    return {
      kind: "peerDependency",
      range: peerRange,
    };
  }

  const dependencyRange = packageJson.dependencies?.[WORKFLOW_WORLD_PACKAGE_NAME];

  if (typeof dependencyRange === "string" && dependencyRange.trim() !== "") {
    return {
      kind: "dependency",
      range: dependencyRange,
    };
  }

  return undefined;
}

function isDeclaredWorkflowWorldDependencyCompatible(input: {
  readonly declaredDependency: DeclaredWorkflowWorldDependency;
}): boolean {
  const minimumVersion = semverApi.minVersion(input.declaredDependency.range);

  if (minimumVersion?.major !== EVE_WORKFLOW_WORLD_SUPPORTED_MAJOR) {
    return false;
  }

  return semverApi.intersects(input.declaredDependency.range, EVE_WORKFLOW_WORLD_SUPPORTED_RANGE, {
    includePrerelease: true,
  });
}

function validateVendoredWorkflowWorldVersion(version: string): void {
  if (
    !semverApi.intersects(version, EVE_WORKFLOW_WORLD_SUPPORTED_RANGE, {
      includePrerelease: true,
    })
  ) {
    throw new Error(
      `eve vendors "${WORKFLOW_WORLD_PACKAGE_NAME}" ${version}, which is outside its supported range ${EVE_WORKFLOW_WORLD_SUPPORTED_RANGE}.`,
    );
  }
}

function resolveEveWorkflowWorldVersion(): string {
  const packageRoot = resolvePackageRoot();

  for (const stampPath of [
    join(packageRoot, ".generated", "compiled", ".vendor-stamp.json"),
    join(packageRoot, "dist", "src", "compiled", ".vendor-stamp.json"),
  ]) {
    if (!existsSync(stampPath)) {
      continue;
    }

    const stamp = readVendorStamp(stampPath);
    const version = stamp.moduleVersions?.[WORKFLOW_WORLD_PACKAGE_NAME];

    if (typeof version === "string" && semverApi.valid(version) !== null) {
      return version;
    }
  }

  throw new Error(
    `eve compiled vendor stamp must declare a valid "${WORKFLOW_WORLD_PACKAGE_NAME}" version.`,
  );
}

function parsePackageName(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || parts[0] === "" || parts[1] === "") {
      throw new Error(
        `"experimental.workflow.world" must be a package name, received ${JSON.stringify(specifier)}.`,
      );
    }

    return `${parts[0]}/${parts[1]}`;
  }

  if (parts[0] === "") {
    throw new Error(
      `"experimental.workflow.world" must be a package name, received ${JSON.stringify(specifier)}.`,
    );
  }

  return parts[0]!;
}

function resolveInstalledPackageJsonPath(appRoot: string, packageName: string): string | undefined {
  const require = createRequire(join(appRoot, "package.json"));
  const resolvedEntrypointPath = tryResolvePackageEntrypoint(require, packageName);
  const resolvedPackageJsonPath =
    resolvedEntrypointPath === undefined
      ? tryResolvePackageJson(require, packageName)
      : findPackageJsonForResolvedEntrypoint(resolvedEntrypointPath, packageName);

  if (resolvedPackageJsonPath !== undefined) {
    return resolvedPackageJsonPath;
  }

  let currentDirectory = appRoot;

  while (true) {
    const candidate = join(currentDirectory, "node_modules", packageName, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function tryResolvePackageEntrypoint(
  require: NodeJS.Require,
  packageName: string,
): string | undefined {
  try {
    return require.resolve(packageName);
  } catch {
    return undefined;
  }
}

function tryResolvePackageJson(require: NodeJS.Require, packageName: string): string | undefined {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function findPackageJsonForResolvedEntrypoint(
  resolvedEntrypointPath: string,
  packageName: string,
): string | undefined {
  let currentDirectory = dirname(resolvedEntrypointPath);

  while (true) {
    const candidate = join(currentDirectory, "package.json");

    if (existsSync(candidate)) {
      const packageJson = readPackageJson(candidate);
      if (packageJson.name === packageName) {
        return candidate;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function readPackageJson(packageJsonPath: string): PackageJson {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
}

function readVendorStamp(stampPath: string): VendorStamp {
  return JSON.parse(readFileSync(stampPath, "utf8")) as VendorStamp;
}
