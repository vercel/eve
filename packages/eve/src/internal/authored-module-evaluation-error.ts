import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ModuleLoadError extends Error {
  readonly code?: unknown;
  readonly url?: unknown;
}

interface InstalledPackageLocation {
  readonly name: string;
  readonly root: string;
}

/** Adds authored-module and installed-package context to Node evaluation failures. */
export function createAuthoredModuleEvaluationError(modulePath: string, cause: unknown): Error {
  const details = describeInstalledPackageLoadFailure(cause);

  return new Error(
    [
      "Failed to evaluate authored module:",
      `  ${modulePath}`,
      ...(details === undefined ? [] : ["", details]),
    ].join("\n"),
    { cause },
  );
}

function describeInstalledPackageLoadFailure(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;

  const error = cause as ModuleLoadError;
  if (error.code !== "ERR_MODULE_NOT_FOUND" || typeof error.url !== "string") {
    return undefined;
  }

  const missingPath = filePathFromUrl(error.url);
  if (missingPath === undefined || extname(missingPath) !== "") {
    return undefined;
  }

  const installedPackage = findInstalledPackage(missingPath);
  if (installedPackage === undefined) return undefined;

  const packageRelativePath = toPackageRelativePath(installedPackage.root, missingPath);
  if (findExistingModulePath(missingPath) !== undefined) {
    return [
      "Failed to load an installed package:",
      `  Package: ${installedPackage.name} (loaded outside the authored bundle)`,
      `  Import: ${packageRelativePath}`,
      "  Reason: Node's ESM loader does not infer file extensions for relative imports.",
      "  Hint: Use a Node-compatible package or entrypoint, or report the extensionless import to the package publisher.",
    ].join("\n");
  }

  return [
    "Failed to load an installed package:",
    `  Package: ${installedPackage.name} (loaded outside the authored bundle)`,
    `  Missing: ${packageRelativePath}`,
    "  Reason: Package output may be incomplete, incorrectly installed, or incompatible with a standalone Node runtime.",
    "  Hint: Verify the installed package version and output, use a Node-compatible entrypoint, or report the missing module to the package publisher.",
  ].join("\n");
}

function findExistingModulePath(path: string): string | undefined {
  for (const extension of [".js", ".mjs", ".cjs"]) {
    const candidate = `${path}${extension}`;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next Node JavaScript extension.
    }
  }

  return undefined;
}

function toPackageRelativePath(packageRoot: string, path: string): string {
  return relative(packageRoot, path).replaceAll("\\", "/");
}

function filePathFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function findInstalledPackage(filePath: string): InstalledPackageLocation | undefined {
  let currentDirectory = dirname(resolve(filePath));

  while (true) {
    const manifestPath = join(currentDirectory, "package.json");
    if (existsSync(manifestPath) && isNodeModulesPath(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.length > 0) {
          return { name: manifest.name, root: currentDirectory };
        }
      } catch {
        return undefined;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return undefined;
    currentDirectory = parentDirectory;
  }
}

function isNodeModulesPath(filePath: string): boolean {
  return filePath.replaceAll("\\", "/").includes("/node_modules/");
}
