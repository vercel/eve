import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { STABLE_WORKFLOW_NAMES } from "#execution/workflow-runtime.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { deriveEveWorkflowQueueTopic } from "#internal/workflow/queue-namespace.js";

import { transformWorkflowDirectives } from "./workflow-transformer.js";

export type WorkflowManifest = {
  steps?: {
    [relativeFileName: string]: {
      [functionName: string]: {
        stepId: string;
      };
    };
  };
  workflows?: {
    [relativeFileName: string]: {
      [functionName: string]: {
        workflowId: string;
      };
    };
  };
  classes?: {
    [relativeFileName: string]: {
      [className: string]: {
        classId: string;
      };
    };
  };
};

export function createEveWorkflowQueueTrigger(agentName: string) {
  return {
    type: "queue/v2beta" as const,
    topic: deriveEveWorkflowQueueTopic(agentName),
    consumer: "default",
    retryAfterSeconds: 5,
    initialDelaySeconds: 0,
  };
}

type PackageInfo = {
  dir: string;
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  name: string;
  version: string;
};

const packageJsonCache = new Map<string, PackageInfo | null>();
const projectDepsCache = new Map<string, Set<string>>();

export async function applyWorkflowTransform(
  filename: string,
  source: string,
  mode: "workflow" | "step" | "client" | false,
  absolutePath?: string,
  projectRoot?: string,
  stableWorkflowNames: ReadonlySet<string> = STABLE_WORKFLOW_NAMES,
): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
}> {
  const resolvedProjectRoot = projectRoot ?? process.cwd();
  const absoluteFilename =
    absolutePath === undefined
      ? isAbsolute(filename)
        ? filename
        : join(resolvedProjectRoot, filename)
      : absolutePath;
  const { moduleSpecifier, stableModuleSpecifier } = resolveModuleSpecifier(
    absoluteFilename,
    resolvedProjectRoot,
  );

  return transformWorkflowDirectives({
    filename,
    mode,
    moduleSpecifier,
    source,
    stableModuleSpecifier,
    stableWorkflowNames,
  });
}

export function detectWorkflowPatterns(source: string): {
  hasSerde: boolean;
  hasUseStep: boolean;
  hasUseWorkflow: boolean;
} {
  return {
    hasSerde:
      source.includes("workflow.serde") ||
      source.includes("@serde") ||
      source.includes("workflowSerde") ||
      source.includes("__workflow_serde"),
    hasUseStep: /["']use step["']/.test(source),
    hasUseWorkflow: /["']use workflow["']/.test(source),
  };
}

export function getImportPath(
  filePath: string,
  projectRoot: string,
): { importPath: string; isPackage: boolean } {
  const inNodeModules = isInNodeModules(filePath);
  const inWorkspace = !inNodeModules && isWorkspacePackage(filePath, projectRoot);

  if (inNodeModules || inWorkspace) {
    const pkg = findPackageJson(filePath);

    if (pkg !== null) {
      const isDirectProjectDependency = getProjectDependencies(projectRoot).has(pkg.name);
      const canUsePackageSpecifier = inWorkspace || isDirectProjectDependency;

      if (!canUsePackageSpecifier) {
        return { importPath: toRelativeImportPath(filePath, projectRoot), isPackage: false };
      }

      const subpath = resolveExportSubpath(filePath, pkg);

      if (subpath) {
        return { importPath: `${pkg.name}${subpath}`, isPackage: true };
      }

      if (!isRootEntrypointFile(filePath, pkg)) {
        return { importPath: toRelativeImportPath(filePath, projectRoot), isPackage: false };
      }

      return { importPath: pkg.name, isPackage: true };
    }
  }

  return { importPath: toRelativeImportPath(filePath, projectRoot), isPackage: false };
}

function resolveModuleSpecifier(
  filePath: string,
  projectRoot: string,
): {
  moduleSpecifier: string | undefined;
  stableModuleSpecifier: string | undefined;
} {
  const inNodeModules = isInNodeModules(filePath);
  const inWorkspace = !inNodeModules && isWorkspacePackage(filePath, projectRoot);
  const pkg = findPackageJson(filePath);

  if (!inNodeModules && !inWorkspace) {
    return {
      moduleSpecifier: undefined,
      stableModuleSpecifier: pkg?.name === EVE_PACKAGE_NAME ? EVE_PACKAGE_NAME : undefined,
    };
  }

  if (pkg === null) {
    return { moduleSpecifier: undefined, stableModuleSpecifier: undefined };
  }

  const subpath = resolveExportSubpath(filePath, pkg);
  // The default specifier is version-stamped for normal workflow/step
  // ids; the stable variant drops the `@<pkg.version>` suffix so
  // {@link STABLE_WORKFLOW_NAMES} functions emit cross-deployment
  // routable ids.
  const base = subpath ? `${pkg.name}${subpath}` : pkg.name;

  return {
    moduleSpecifier: `${base}@${pkg.version}`,
    stableModuleSpecifier: base,
  };
}

function findPackageJson(filePath: string): PackageInfo | null {
  let dir = dirname(filePath);
  const visitedDirs: string[] = [];

  while (dir !== dirname(dir)) {
    const cached = packageJsonCache.get(dir);

    if (cached !== undefined) {
      for (const visitedDir of visitedDirs) {
        packageJsonCache.set(visitedDir, cached);
      }
      return cached;
    }

    visitedDirs.push(dir);
    const packageJsonPath = join(dir, "package.json");

    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          exports?: unknown;
          main?: unknown;
          module?: unknown;
          name?: unknown;
          version?: unknown;
        };

        if (typeof parsed.name === "string" && typeof parsed.version === "string") {
          const result: PackageInfo = {
            dir,
            exports: parsed.exports,
            main: parsed.main,
            module: parsed.module,
            name: parsed.name,
            version: parsed.version,
          };
          packageJsonCache.set(dir, result);
          for (const visitedDir of visitedDirs) {
            packageJsonCache.set(visitedDir, result);
          }
          return result;
        }
      } catch {
        // Continue searching ancestors.
      }
    }

    dir = dirname(dir);
  }

  for (const visitedDir of visitedDirs) {
    packageJsonCache.set(visitedDir, null);
  }
  return null;
}

function resolveExportSubpath(filePath: string, pkg: PackageInfo): string {
  if (pkg.exports === null || typeof pkg.exports !== "object" || Array.isArray(pkg.exports)) {
    return "";
  }

  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedPkgDir = pkg.dir.replace(/\\/g, "/");
  const relativePath = normalizedFilePath.startsWith(`${normalizedPkgDir}/`)
    ? `./${normalizedFilePath.substring(normalizedPkgDir.length + 1)}`
    : null;

  if (relativePath === null) {
    return "";
  }

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const resolvedTarget = resolveExportTarget(target);

    if (resolvedTarget !== null && normalizeExportPath(resolvedTarget) === relativePath) {
      return subpath === "." ? "" : subpath.substring(1);
    }
  }

  return "";
}

function resolveExportTarget(target: unknown): string | null {
  if (typeof target === "string") {
    return target;
  }

  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item);

      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }

  if (target !== null && typeof target === "object") {
    for (const condition of ["workflow", "default", "require", "import", "node"]) {
      const value = (target as Record<string, unknown>)[condition];
      const resolved = resolveExportTarget(value);

      if (resolved !== null) {
        return resolved;
      }
    }
  }

  return null;
}

function normalizeExportPath(path: string): string {
  return path.startsWith("./") ? path : `./${path}`;
}

function isInNodeModules(filePath: string): boolean {
  return filePath.split(sep).join("/").includes("/node_modules/");
}

function getProjectDependencies(projectRoot: string): Set<string> {
  const cached = projectDepsCache.get(projectRoot);

  if (cached !== undefined) {
    return cached;
  }

  const deps = new Set<string>();
  const pkgPath = join(projectRoot, "package.json");

  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;

      for (const depType of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const depObj = parsed[depType];

        if (depObj !== null && typeof depObj === "object" && !Array.isArray(depObj)) {
          for (const name of Object.keys(depObj)) {
            deps.add(name);
          }
        }
      }
    } catch {
      // Ignore invalid package metadata.
    }
  }

  projectDepsCache.set(projectRoot, deps);
  return deps;
}

function isWorkspacePackage(filePath: string, projectRoot: string): boolean {
  if (isInNodeModules(filePath)) {
    return false;
  }

  const pkg = findPackageJson(filePath);

  if (pkg === null) {
    return false;
  }

  if (resolve(pkg.dir) === resolve(projectRoot)) {
    return false;
  }

  return getProjectDependencies(projectRoot).has(pkg.name);
}

function toRelativeImportPath(filePath: string, projectRoot: string): string {
  const normalizedProjectRoot = projectRoot.replace(/\\/g, "/");
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  let relativePath = normalizedFilePath.startsWith(`${normalizedProjectRoot}/`)
    ? normalizedFilePath.substring(normalizedProjectRoot.length + 1)
    : relative(projectRoot, filePath).replace(/\\/g, "/");

  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

function hasRootExport(exportsField: unknown): boolean {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return true;
  }

  if (exportsField === null || typeof exportsField !== "object") {
    return false;
  }

  const keys = Object.keys(exportsField);

  if (keys.length > 0 && keys.every((key) => !key.startsWith("."))) {
    return true;
  }

  return "." in exportsField;
}

function normalizePackageTargetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");

  if (normalized.startsWith("./")) {
    return normalized.substring(2);
  }

  if (normalized.startsWith("/")) {
    return normalized.substring(1);
  }

  return normalized;
}

function isRootEntrypointFile(filePath: string, pkg: PackageInfo): boolean {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedPkgDir = pkg.dir.replace(/\\/g, "/");

  if (!normalizedFilePath.startsWith(`${normalizedPkgDir}/`)) {
    return false;
  }

  const relativeFilePath = normalizedFilePath.substring(normalizedPkgDir.length + 1);

  if (pkg.exports !== undefined) {
    let rootTarget: unknown;

    if (pkg.exports !== null && typeof pkg.exports === "object" && "." in pkg.exports) {
      rootTarget = (pkg.exports as Record<string, unknown>)["."];
    } else if (hasRootExport(pkg.exports)) {
      rootTarget = pkg.exports;
    } else {
      return false;
    }

    const resolvedTarget = resolveExportTarget(rootTarget);

    return (
      resolvedTarget !== null && normalizePackageTargetPath(resolvedTarget) === relativeFilePath
    );
  }

  const rootCandidates = [
    pkg.module,
    pkg.main,
    "index.js",
    "index.mjs",
    "index.cjs",
    "index.ts",
    "index.mts",
    "index.cts",
  ].flatMap((candidate) =>
    typeof candidate === "string" ? [normalizePackageTargetPath(candidate)] : [],
  );

  return rootCandidates.includes(relativeFilePath);
}

export async function readSourceFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}
