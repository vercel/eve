import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

let cachedPackageInfo: InstalledPackageInfo | undefined;
// The package build stamps the published version into `dist` so bundled
// deployments can still report package metadata without resolving package.json.
const BUNDLED_FALLBACK_PACKAGE_VERSION: string = "__EVE_PACKAGE_VERSION__";
const WORKFLOW_MODULE_ALIASES = {
  "workflow/api": "src/compiled/@workflow/core/runtime.js",
  "workflow/errors": "src/compiled/@workflow/errors/index.js",
  "workflow/internal/private": "src/compiled/@workflow/core/private.js",
  "workflow/runtime": "src/compiled/@workflow/core/runtime.js",
} as const;

function resolveFallbackPackageVersion(): string {
  // Detect an unstamped build by the token's `__` shape — spelling the token
  // out in a comparison would get rewritten by the stamp itself.
  return BUNDLED_FALLBACK_PACKAGE_VERSION.startsWith("__")
    ? "0.0.0"
    : BUNDLED_FALLBACK_PACKAGE_VERSION;
}

const FALLBACK_PACKAGE_INFO: InstalledPackageInfo = {
  name: EVE_PACKAGE_NAME,
  version: resolveFallbackPackageVersion(),
};

interface InstalledPackageInfo {
  name: string;
  version: string;
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

function isBuildOutputPackageRoot(directoryPath: string): boolean {
  return (
    basename(directoryPath) === "dist" && existsSync(join(dirname(directoryPath), "package.json"))
  );
}

function resolvePackageBuildRoot(): string | null {
  let currentDirectory = dirname(realpathSync(resolveCurrentModulePath()));

  while (true) {
    if (isBuildOutputPackageRoot(currentDirectory)) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function findNearestPackageRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;

  while (true) {
    if (
      existsSync(join(currentDirectory, "package.json")) &&
      !isBuildOutputPackageRoot(currentDirectory)
    ) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(`Failed to resolve package root from "${startDirectory}".`);
    }

    currentDirectory = parentDirectory;
  }
}

/**
 * Resolves the installed eve package root.
 */
export function resolvePackageRoot(): string {
  // Canonicalize the current module path so workspace symlinks such as
  // app-local `node_modules/<package-name>` resolve back to the real package root.
  return findNearestPackageRoot(dirname(realpathSync(resolveCurrentModulePath())));
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

function resolvePackageCompiledFilePath(relativeCompiledPath: string): string {
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

  if (specifier === "workflow/internal/builtins") {
    return resolvePackageSourceFilePath("src/internal/workflow/builtins.ts");
  }

  const alias = WORKFLOW_MODULE_ALIASES[specifier as keyof typeof WORKFLOW_MODULE_ALIASES];

  if (alias !== undefined) {
    return resolvePackageCompiledFilePath(alias);
  }

  return require.resolve(specifier);
}
