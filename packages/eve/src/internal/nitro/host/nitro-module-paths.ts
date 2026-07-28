import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";

const WORKFLOW_CACHE_PATH_FRAGMENT = "/.eve/workflow-cache/";

export function normalizeNitroModulePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function stripPathQueryAndHash(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutoff =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  return cutoff === -1 ? path : path.slice(0, cutoff);
}

function stripFileSystemPrefix(path: string): string {
  return path.startsWith("/@fs/") ? path.slice("/@fs".length) : path;
}

export function resolveNitroModuleComparisonPath(rootDir: string, path: string): string {
  if (path.startsWith("file://")) {
    return normalizeNitroModulePath(
      stripFileSystemPrefix(stripPathQueryAndHash(fileURLToPath(path))),
    );
  }

  if (isAbsolute(path)) {
    return normalizeNitroModulePath(stripFileSystemPrefix(stripPathQueryAndHash(path)));
  }

  return normalizeNitroModulePath(
    stripFileSystemPrefix(stripPathQueryAndHash(resolve(rootDir, path))),
  );
}

export function isWorkflowBundlePath(path: string, normalizedWorkflowBuildDir: string): boolean {
  const normalizedPath = normalizeNitroModulePath(path);

  return (
    normalizedPath.startsWith(normalizedWorkflowBuildDir) ||
    normalizedPath.includes(WORKFLOW_CACHE_PATH_FRAGMENT)
  );
}

export function normalizeStepTransformComparisonPath(path: string): string {
  const normalizedPath = normalizeNitroModulePath(path);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function parseImportedModuleSpecifiers(source: string): string[] {
  const importSpecifierPattern = /^\s*import\s+(?:.+?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
  const importedSpecifiers: string[] = [];

  for (const match of source.matchAll(importSpecifierPattern)) {
    const importedSpecifier = match[1];
    if (importedSpecifier !== undefined) {
      importedSpecifiers.push(importedSpecifier);
    }
  }

  return importedSpecifiers;
}

export function resolveNitroImportPath(
  rootDir: string,
  importSpecifier: string,
  importer?: string,
): string | null {
  if (importSpecifier.startsWith("workflow")) {
    return resolveWorkflowModulePath(importSpecifier);
  }

  if (
    importSpecifier.startsWith(".") ||
    importSpecifier.startsWith("/") ||
    importSpecifier.startsWith("file://")
  ) {
    const importerDirectory =
      importer === undefined
        ? rootDir
        : dirname(resolveNitroModuleComparisonPath(rootDir, importer));

    return resolveNitroModuleComparisonPath(importerDirectory, importSpecifier);
  }

  return null;
}

export async function collectNitroStepTransformTargets(
  stepEntrypointPath: string,
  rootDir: string,
): Promise<Set<string>> {
  const stepEntrypointSource = await readFile(stepEntrypointPath, "utf8");
  const stepTransformTargets = new Set<string>();

  for (const importSpecifier of parseImportedModuleSpecifiers(stepEntrypointSource)) {
    const resolvedImportPath = resolveNitroImportPath(rootDir, importSpecifier, stepEntrypointPath);

    if (resolvedImportPath !== null) {
      stepTransformTargets.add(normalizeStepTransformComparisonPath(resolvedImportPath));
    }
  }

  return stepTransformTargets;
}

export function createRelativeTransformFilename(workingDir: string, path: string): string {
  const packageRelativePath = createPackageRelativeTransformFilename(path);
  if (packageRelativePath !== undefined) {
    return packageRelativePath;
  }

  const normalizedWorkingDir = normalizeNitroModulePath(workingDir).replace(/\/$/, "");
  const normalizedPath = normalizeNitroModulePath(path);
  const lowerWorkingDir = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();

  if (lowerPath.startsWith(`${lowerWorkingDir}/`)) {
    return normalizedPath.slice(normalizedWorkingDir.length + 1);
  }

  if (lowerPath === lowerWorkingDir) {
    return ".";
  }

  let relativePath = relative(normalizedWorkingDir, normalizedPath).replaceAll("\\", "/");

  if (relativePath.startsWith("../")) {
    relativePath = relativePath
      .split("/")
      .filter((part) => part !== "..")
      .join("/");
  }

  if (relativePath.includes(":") || relativePath.startsWith("/")) {
    const filename = normalizedPath.split("/").pop();
    return filename === undefined || filename.length === 0 ? "unknown.ts" : filename;
  }

  return relativePath;
}

function createPackageRelativeTransformFilename(path: string): string | undefined {
  const normalizedPackageRoot = normalizeNitroModulePath(resolvePackageRoot()).replace(/\/$/, "");
  const normalizedPath = normalizeNitroModulePath(path);
  const lowerPackageRoot = normalizedPackageRoot.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const packageSourcePrefix = `${normalizedPackageRoot}/src/`;
  const lowerPackageSourcePrefix = `${lowerPackageRoot}/src/`;
  const packageDistSourcePrefix = `${normalizedPackageRoot}/dist/src/`;
  const lowerPackageDistSourcePrefix = `${lowerPackageRoot}/dist/src/`;

  if (lowerPath.startsWith(lowerPackageSourcePrefix)) {
    return `src/${normalizedPath.slice(packageSourcePrefix.length)}`;
  }

  if (lowerPath.startsWith(lowerPackageDistSourcePrefix)) {
    return `src/${normalizedPath.slice(packageDistSourcePrefix.length)}`;
  }

  return undefined;
}
