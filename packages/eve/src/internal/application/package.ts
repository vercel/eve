import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readStampedPackageVersion } from "#internal/application/stamped-package-version.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

let cachedPackageInfo: InstalledPackageInfo | undefined;
let cachedPackageLocation: PackageLocation | undefined;
const WORKFLOW_SOURCE_MODULE_ALIASES: Readonly<Record<string, string>> = {
  "eve/workflow": "src/internal/workflow/index.ts",
  workflow: "src/internal/workflow/index.ts",
  "eve/workflow/api": "src/public/workflow/api.ts",
  "workflow/api": "src/internal/workflow/runtime.ts",
  "workflow/runtime": "src/internal/workflow/runtime.ts",
  "workflow/internal/builtins": "src/internal/workflow/builtins.ts",
};
const WORKFLOW_MODULE_ALIASES: Readonly<Record<string, string>> = {
  "workflow/errors": "src/compiled/@workflow/errors/index.js",
  "workflow/internal/private": "src/compiled/@workflow/core/private.js",
};
export const WORKFLOW_MODULE_SPECIFIERS: readonly string[] = [
  ...Object.keys(WORKFLOW_SOURCE_MODULE_ALIASES),
  ...Object.keys(WORKFLOW_MODULE_ALIASES),
];

interface InstalledPackageInfo {
  name: string;
  version: string;
}

interface PackageLocation {
  packageBuildRoot: string | null;
  packageRoot: string;
}

function resolveCurrentModulePath(): string {
  if (typeof __filename === "string" && isAbsolute(__filename)) {
    return __filename;
  }

  return resolveCurrentModulePathFromStack();
}

function resolveCurrentModulePathFromStack(): string {
  const previousPrepareStackTrace = Error.prepareStackTrace;

  try {
    Error.prepareStackTrace = (_error, stack) => stack;

    const stack = new Error().stack as NodeJS.CallSite[] | undefined;
    const currentFileName = stack?.[0]?.getFileName();

    if (typeof currentFileName !== "string" || currentFileName.length === 0) {
      throw new Error("Failed to resolve the current module path from the stack trace.");
    }

    return currentFileName.startsWith("file:") ? fileURLToPath(currentFileName) : currentFileName;
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace;
  }
}

const packageRequire = createRequire(resolveCurrentModulePath());

function tryResolveVerifiedPackageRoot(packageJsonPath: string): string | undefined {
  try {
    const canonicalPackageJsonPath = realpathSync.native(packageJsonPath);
    const packageInfo = tryReadInstalledPackageInfo(canonicalPackageJsonPath, EVE_PACKAGE_NAME);

    return packageInfo === undefined ? undefined : dirname(canonicalPackageJsonPath);
  } catch {
    return undefined;
  }
}

function findNearestVerifiedPackageRoot(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;

  while (true) {
    const packageRoot = tryResolveVerifiedPackageRoot(join(currentDirectory, "package.json"));

    if (packageRoot !== undefined) {
      return packageRoot;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function tryResolveDirectBuildLocation(currentModulePath: string): PackageLocation | undefined {
  let currentDirectory = dirname(currentModulePath);

  while (true) {
    if (basename(currentDirectory) === "dist") {
      const packageRoot = tryResolveVerifiedPackageRoot(
        join(dirname(currentDirectory), "package.json"),
      );

      if (packageRoot !== undefined) {
        return {
          packageBuildRoot: currentDirectory,
          packageRoot,
        };
      }
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function isSourceCheckout(packageRoot: string): boolean {
  return existsSync(join(packageRoot, "src", "internal", "application", "package.ts"));
}

function findNearestSourceCheckoutRoot(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;

  while (true) {
    if (isSourceCheckout(currentDirectory)) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function tryCreatePackageLocation(packageRoot: string): PackageLocation | undefined {
  if (isSourceCheckout(packageRoot)) {
    return {
      packageBuildRoot: null,
      packageRoot,
    };
  }

  const packageBuildRoot = join(packageRoot, "dist");

  if (!existsSync(packageBuildRoot)) {
    return undefined;
  }

  return {
    packageBuildRoot,
    packageRoot,
  };
}

function resolveSelfPackageJsonPath(currentModulePath: string): string {
  return createRequire(currentModulePath).resolve(`${EVE_PACKAGE_NAME}/package.json`);
}

export function resolvePackageLocationFromModulePath(
  currentModulePath: string,
  resolvePackageJsonPath: (currentModulePath: string) => string = resolveSelfPackageJsonPath,
): PackageLocation {
  const canonicalModulePath = realpathSync.native(currentModulePath);
  const directBuildLocation = tryResolveDirectBuildLocation(canonicalModulePath);

  if (directBuildLocation !== undefined) {
    return directBuildLocation;
  }

  const nearestPackageRoot = findNearestVerifiedPackageRoot(dirname(canonicalModulePath));

  if (nearestPackageRoot !== undefined && isSourceCheckout(nearestPackageRoot)) {
    return {
      packageBuildRoot: null,
      packageRoot: nearestPackageRoot,
    };
  }

  try {
    const resolvedPackageRoot = tryResolveVerifiedPackageRoot(
      resolvePackageJsonPath(canonicalModulePath),
    );
    const resolvedLocation =
      resolvedPackageRoot === undefined ? undefined : tryCreatePackageLocation(resolvedPackageRoot);

    if (resolvedLocation !== undefined) {
      return resolvedLocation;
    }
  } catch {}

  const fallbackLocation =
    nearestPackageRoot === undefined ? undefined : tryCreatePackageLocation(nearestPackageRoot);

  if (fallbackLocation !== undefined) {
    return fallbackLocation;
  }

  throw new Error(`Failed to resolve the eve package root from "${currentModulePath}".`);
}

function resolvePackageLocation(): PackageLocation {
  cachedPackageLocation ??= resolvePackageLocationFromModulePath(resolveCurrentModulePath());
  return cachedPackageLocation;
}

function resolvePackageBuildRoot(): string | null {
  return resolvePackageLocation().packageBuildRoot;
}

export function resolvePackageRoot(): string {
  return resolvePackageLocation().packageRoot;
}

function tryResolvePackageRoot(): string | undefined {
  try {
    return resolvePackageRoot();
  } catch {
    return undefined;
  }
}

function tryResolveLocalPackageRoot(currentModulePath: string): string | undefined {
  try {
    const canonicalModulePath = realpathSync.native(currentModulePath);
    const directBuildLocation = tryResolveDirectBuildLocation(canonicalModulePath);

    if (directBuildLocation !== undefined) {
      return directBuildLocation.packageRoot;
    }

    const sourceCheckoutRoot = findNearestSourceCheckoutRoot(dirname(canonicalModulePath));

    return sourceCheckoutRoot === undefined
      ? undefined
      : tryResolveVerifiedPackageRoot(join(sourceCheckoutRoot, "package.json"));
  } catch {
    return undefined;
  }
}

function rewriteSourceFilePathForBuild(relativeSourcePath: string): string {
  return relativeSourcePath.replace(/\.[cm]?tsx?$/, ".js");
}

export function resolvePackageSourceFilePath(relativeSourcePath: string): string {
  const packageBuildRoot = resolvePackageBuildRoot();

  if (packageBuildRoot !== null) {
    return join(packageBuildRoot, rewriteSourceFilePathForBuild(relativeSourcePath));
  }

  return join(resolvePackageRoot(), relativeSourcePath);
}

export function resolvePackageSourceDirectoryPath(relativeSourcePath: string): string {
  const packageBuildRoot = resolvePackageBuildRoot();

  if (packageBuildRoot !== null) {
    return join(packageBuildRoot, relativeSourcePath);
  }

  return join(resolvePackageRoot(), relativeSourcePath);
}

const resolvedDependencyPaths = new Map<string, string>();

export function resolvePackageDependencyPath(specifier: string): string {
  const resolved = resolvedDependencyPaths.get(specifier);
  if (resolved !== undefined) return resolved;
  const path = resolveUncachedPackageDependencyPath(specifier);
  resolvedDependencyPaths.set(specifier, path);
  return path;
}

function resolveUncachedPackageDependencyPath(specifier: string): string {
  try {
    return packageRequire.resolve(specifier);
  } catch (error) {
    const packageRoot = tryResolvePackageRoot();
    const sourcePath =
      packageRoot === undefined || !isSourceCheckout(packageRoot)
        ? undefined
        : resolveSourceCheckoutExport(packageRoot, specifier);
    if (sourcePath !== undefined) return sourcePath;
    throw error;
  }
}

function resolveSourceCheckoutExport(packageRoot: string, specifier: string): string | undefined {
  if (specifier !== EVE_PACKAGE_NAME && !specifier.startsWith(`${EVE_PACKAGE_NAME}/`)) {
    return undefined;
  }
  const exportKey =
    specifier === EVE_PACKAGE_NAME ? "." : `.${specifier.slice(EVE_PACKAGE_NAME.length)}`;
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, string | Record<string, string>>;
    };
    const declaration = manifest.exports?.[exportKey];
    const target =
      typeof declaration === "string"
        ? declaration
        : (declaration?.["eve-source"] ?? declaration?.import ?? declaration?.default);
    if (target === undefined) return undefined;
    const sourceRelativePath = target
      .replace(/^\.\/dist\/src\//, "src/")
      .replace(/\.[cm]?js$/u, ".ts");
    const sourcePath = join(packageRoot, sourceRelativePath);
    return existsSync(sourcePath) ? sourcePath : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePackageCompiledFilePath(relativeCompiledPath: string): string {
  const packageBuildRoot = resolvePackageBuildRoot();

  if (packageBuildRoot !== null) {
    return join(packageBuildRoot, relativeCompiledPath);
  }

  return join(
    resolvePackageRoot(),
    ".generated",
    "compiled",
    relativeCompiledPath.replace(/^src\/compiled\//, ""),
  );
}

function normalizeInstalledPackageInfo(value: unknown): InstalledPackageInfo | undefined {
  const packageJson = value as {
    name?: unknown;
    version?: unknown;
  };

  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    return undefined;
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
  };
}

function tryReadInstalledPackageInfo(
  packageJsonPath: string,
  expectedPackageName: string,
): InstalledPackageInfo | undefined {
  const resolvedPackageInfo = normalizeInstalledPackageInfo(
    JSON.parse(readFileSync(packageJsonPath, "utf8")),
  );

  if (resolvedPackageInfo?.name !== expectedPackageName) {
    return undefined;
  }

  return resolvedPackageInfo;
}

function tryResolveSelfPackageInfo(): InstalledPackageInfo | undefined {
  try {
    return tryReadInstalledPackageInfo(
      packageRequire.resolve(`${EVE_PACKAGE_NAME}/package.json`),
      EVE_PACKAGE_NAME,
    );
  } catch {
    return undefined;
  }
}

export function resolveInstalledPackageInfo(): InstalledPackageInfo {
  if (cachedPackageInfo) {
    return cachedPackageInfo;
  }

  const packageRoot = tryResolveLocalPackageRoot(resolveCurrentModulePath());
  const packageRootInfo =
    packageRoot === undefined
      ? undefined
      : tryReadInstalledPackageInfo(join(packageRoot, "package.json"), EVE_PACKAGE_NAME);

  if (packageRootInfo) {
    cachedPackageInfo = packageRootInfo;
    return cachedPackageInfo;
  }

  const stampedVersion = readStampedPackageVersion();

  if (stampedVersion !== undefined) {
    cachedPackageInfo = { name: EVE_PACKAGE_NAME, version: stampedVersion };
    return cachedPackageInfo;
  }

  cachedPackageInfo = tryResolveSelfPackageInfo() ?? {
    name: EVE_PACKAGE_NAME,
    version: "0.0.0",
  };

  return cachedPackageInfo;
}

const EXPECTED_WORKFLOW_VERSION_PACKAGE = "@workflow/core";

function readWorkflowVersionFromManifest(value: unknown): string | undefined {
  const manifest = value as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };

  for (const section of [
    manifest.devDependencies,
    manifest.dependencies,
    manifest.peerDependencies,
  ]) {
    const declared = section?.[EXPECTED_WORKFLOW_VERSION_PACKAGE];

    if (typeof declared === "string" && declared.trim().length > 0) {
      return declared;
    }
  }

  return undefined;
}

export function resolveExpectedWorkflowVersion(): string | undefined {
  const packageRoot = tryResolvePackageRoot();

  if (packageRoot !== undefined) {
    try {
      return readWorkflowVersionFromManifest(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      );
    } catch {}
  }

  try {
    return readWorkflowVersionFromManifest(
      JSON.parse(readFileSync(packageRequire.resolve(`${EVE_PACKAGE_NAME}/package.json`), "utf8")),
    );
  } catch {
    return undefined;
  }
}

export function resolveWorkflowModulePath(specifier: string): string {
  const source = WORKFLOW_SOURCE_MODULE_ALIASES[specifier];
  if (source !== undefined) return resolvePackageSourceFilePath(source);

  const alias = WORKFLOW_MODULE_ALIASES[specifier];

  if (alias !== undefined) {
    return resolvePackageCompiledFilePath(alias);
  }

  return packageRequire.resolve(specifier);
}
