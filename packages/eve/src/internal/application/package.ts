import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { bundledEveVersion } from "#internal/package-version.js";

let cachedPackageInfo: InstalledPackageInfo | undefined;
let cachedPackageLocation: PackageLocation | undefined;
const WORKFLOW_MODULE_ALIASES = {
  "workflow/errors": "src/compiled/@workflow/errors/index.js",
  "workflow/internal/private": "src/compiled/@workflow/core/private.js",
} as const;

const FALLBACK_PACKAGE_INFO: InstalledPackageInfo = {
  name: EVE_PACKAGE_NAME,
  version: bundledEveVersion(),
};

interface InstalledPackageInfo {
  name: string;
  version: string;
}

interface PackageLocation {
  packageBuildRoot: string | null;
  packageRoot: string;
}

function resolveCurrentModulePath(): string {
  if (typeof __filename === "string") {
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

const require = createRequire(resolveCurrentModulePath());

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
  // Published packages exclude `src`, so this marker distinguishes a checkout
  // without depending on how its parent directories are named.
  return existsSync(join(packageRoot, "src", "internal", "application", "package.ts"));
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

/**
 * Resolves eve's package location relative to an executing module.
 *
 * Direct source and build executions retain their package-local behavior.
 * Bundled executions resolve the installed eve manifest through Node's module
 * resolver instead of treating the bundle owner's manifest as eve's.
 */
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
  } catch {
    // A verified package root surrounding the current module remains a safe
    // fallback when module resolution is unavailable in generated output.
  }

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

/**
 * Resolves the installed eve package root.
 */
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

function rewriteSourceFilePathForBuild(relativeSourcePath: string): string {
  return relativeSourcePath.replace(/\.[cm]?tsx?$/, ".js");
}

/**
 * Resolves one package-owned source file from the currently executing eve installation.
 *
 * Source checkouts use `src/...` paths so local tests exercise live source files.
 * Installed or built package executions use `dist/src/...` so published builds do
 * not depend on unpublished TypeScript sources.
 */
export function resolvePackageSourceFilePath(relativeSourcePath: string): string {
  const packageBuildRoot = resolvePackageBuildRoot();

  if (packageBuildRoot !== null) {
    return join(packageBuildRoot, rewriteSourceFilePathForBuild(relativeSourcePath));
  }

  return join(resolvePackageRoot(), relativeSourcePath);
}

/**
 * Resolves one package-owned source directory from the currently executing eve installation.
 */
export function resolvePackageSourceDirectoryPath(relativeSourcePath: string): string {
  const packageBuildRoot = resolvePackageBuildRoot();

  if (packageBuildRoot !== null) {
    return join(packageBuildRoot, relativeSourcePath);
  }

  return join(resolvePackageRoot(), relativeSourcePath);
}

export function resolvePackageDependencyPath(specifier: string): string {
  return require.resolve(specifier);
}

/**
 * Resolves one vendored compiled asset from the current eve installation.
 */
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

/**
 * Resolves the installed eve package identity from package.json.
 */
export function resolveInstalledPackageInfo(): InstalledPackageInfo {
  if (cachedPackageInfo) {
    return cachedPackageInfo;
  }

  const packageRoot = tryResolvePackageRoot();
  const packageRootInfo =
    packageRoot === undefined
      ? undefined
      : tryReadInstalledPackageInfo(join(packageRoot, "package.json"), EVE_PACKAGE_NAME);

  if (packageRootInfo) {
    cachedPackageInfo = packageRootInfo;
    return cachedPackageInfo;
  }

  try {
    const resolvedPackageJsonPath = require.resolve(`${EVE_PACKAGE_NAME}/package.json`);
    const resolvedPackageInfo = tryReadInstalledPackageInfo(
      resolvedPackageJsonPath,
      EVE_PACKAGE_NAME,
    );

    if (resolvedPackageInfo) {
      cachedPackageInfo = resolvedPackageInfo;
      return cachedPackageInfo;
    }
  } catch {
    // Fall back to the package's development identity when the self package
    // cannot be resolved from bundled runtime output.
  }

  cachedPackageInfo = {
    ...FALLBACK_PACKAGE_INFO,
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

/**
 * Resolves the `@workflow/core` version this eve release bundles, read from
 * eve's own `package.json`.
 *
 * This is the single source of truth for the `@workflow/*` line eve targets, so
 * compatibility checks never hardcode a version. eve's `package.json` is
 * published with its `devDependencies` intact even though those packages are
 * vendored, so the entry is readable from an installed eve as well as a source
 * checkout. Returns `undefined` when the entry cannot be read so callers can
 * no-op rather than fail.
 */
export function resolveExpectedWorkflowVersion(): string | undefined {
  const packageRoot = tryResolvePackageRoot();

  if (packageRoot !== undefined) {
    try {
      return readWorkflowVersionFromManifest(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      );
    } catch {
      // Fall through to module-resolution lookup below.
    }
  }

  try {
    return readWorkflowVersionFromManifest(
      JSON.parse(readFileSync(require.resolve(`${EVE_PACKAGE_NAME}/package.json`), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolves a Workflow runtime module from eve's narrowed Workflow dependencies.
 *
 * Older Workflow builder output still uses `workflow/*` specifiers. eve maps
 * those historical specifiers to the smaller `@workflow/*` packages it actually
 * needs, plus an eve-owned builtins module for response body step helpers.
 */
export function resolveWorkflowModulePath(specifier: string): string {
  if (specifier === "workflow") {
    return resolvePackageSourceFilePath("src/internal/workflow/index.ts");
  }

  if (specifier === "workflow/api" || specifier === "workflow/runtime") {
    return resolvePackageSourceFilePath("src/internal/workflow/runtime.ts");
  }

  if (specifier === "workflow/internal/builtins") {
    return resolvePackageSourceFilePath("src/internal/workflow/builtins.ts");
  }

  const alias = WORKFLOW_MODULE_ALIASES[specifier as keyof typeof WORKFLOW_MODULE_ALIASES];

  if (alias !== undefined) {
    return resolvePackageCompiledFilePath(alias);
  }

  return require.resolve(specifier);
}
