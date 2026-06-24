import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { NodeEngineOverride } from "../node-engine.js";
import type { PackageManagerKind } from "../package-manager.js";
import { getPackageManagerStrategy } from "../primitives/pm/index.js";
import {
  ensurePnpmWorkspaceIncludesProject,
  findAncestorPnpmWorkspaceRoot,
} from "../primitives/pm/pnpm.js";
import {
  isPathInside,
  workspacePatternForProject,
  workspacePatternsClaimProject,
} from "./workspace-glob.js";
import { patchPackageJson } from "./update/package-json.js";
import type { PackageJsonPatch, PackageJsonPatchResult } from "./update/package-json.js";

interface PackageJsonWorkspaceShape {
  workspaces?: unknown;
}

export interface WorkspaceRootMutation {
  kind: "package-json" | "workspace-config";
  nodeEngineOverride?: NodeEngineOverride;
  path: string;
}

export interface WorkspaceRootPackageJsonPatchResult extends PackageJsonPatchResult {
  /** Root package.json path when an ancestor workspace root was eligible for patching. */
  path?: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageJsonWorkspacePatterns(packageJson: PackageJsonWorkspaceShape): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (!isJsonObject(workspaces) || !Array.isArray(workspaces.packages)) return [];
  return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
}

function readPackageJsonWorkspacePatterns(packageJsonPath: string): string[] | undefined {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isJsonObject(parsed)) return undefined;
  const patterns = packageJsonWorkspacePatterns(parsed as PackageJsonWorkspaceShape);
  return patterns.length === 0 ? undefined : patterns;
}

function findAncestorPackageJsonWorkspaceRoot(projectRoot: string): string | undefined {
  let dir = dirname(resolve(projectRoot));
  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        if (readPackageJsonWorkspacePatterns(packageJsonPath) !== undefined) return dir;
      } catch {
        // Keep walking; an unreadable package.json is not a reliable workspace owner.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findClaimingPackageJsonWorkspaceRoot(projectRoot: string): string | undefined {
  const workspaceRoot = findAncestorPackageJsonWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined) return undefined;
  let patterns: string[] | undefined;
  try {
    patterns = readPackageJsonWorkspacePatterns(join(workspaceRoot, "package.json"));
  } catch {
    return undefined;
  }
  return patterns !== undefined &&
    workspacePatternsClaimProject(patterns, workspaceRoot, projectRoot)
    ? workspaceRoot
    : undefined;
}

/** Ancestor package-manager workspace root that owns root-only package.json fields. */
function findPackageManagerWorkspaceRoot(
  packageManager: PackageManagerKind,
  projectRoot: string,
): string | undefined {
  switch (packageManager) {
    case "pnpm":
      return findAncestorPnpmWorkspaceRoot(projectRoot);
    case "bun":
    case "npm":
    case "yarn":
      return findAncestorPackageJsonWorkspaceRoot(projectRoot);
  }
}

export function isPackageManagerWorkspaceMember(
  packageManager: PackageManagerKind,
  projectRoot: string,
): boolean {
  const workspaceRoot = findPackageManagerWorkspaceRoot(packageManager, projectRoot);
  return workspaceRoot !== undefined && resolve(workspaceRoot) !== resolve(projectRoot);
}

function workspaceRootPackageJsonPath(
  packageManager: PackageManagerKind,
  projectRoot: string,
): string | undefined {
  const workspaceRoot = findPackageManagerWorkspaceRoot(packageManager, projectRoot);
  return workspaceRoot === undefined ? undefined : join(workspaceRoot, "package.json");
}

async function ensurePackageJsonWorkspaceIncludesProject(
  projectRoot: string,
): Promise<string | undefined> {
  const workspaceRoot = findAncestorPackageJsonWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined || resolve(workspaceRoot) === resolve(projectRoot)) {
    return undefined;
  }
  if (findClaimingPackageJsonWorkspaceRoot(projectRoot) === workspaceRoot) {
    return undefined;
  }

  const packageJsonPath = join(workspaceRoot, "package.json");
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonWorkspaceShape;
  const pattern = workspacePatternForProject(workspaceRoot, projectRoot);
  if (Array.isArray(parsed.workspaces)) {
    parsed.workspaces = [...parsed.workspaces, pattern];
  } else if (isJsonObject(parsed.workspaces) && Array.isArray(parsed.workspaces.packages)) {
    parsed.workspaces = {
      ...parsed.workspaces,
      packages: [...parsed.workspaces.packages, pattern],
    };
  } else {
    return undefined;
  }
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return packageJsonPath;
}

async function ensurePackageManagerWorkspaceIncludesProject(
  packageManager: PackageManagerKind,
  projectRoot: string,
): Promise<string | undefined> {
  switch (packageManager) {
    case "pnpm": {
      const workspaceRoot = findAncestorPnpmWorkspaceRoot(projectRoot);
      if (workspaceRoot === undefined) return undefined;
      const result = await ensurePnpmWorkspaceIncludesProject(projectRoot);
      return result === "written" ? join(workspaceRoot, "pnpm-workspace.yaml") : undefined;
    }
    case "bun":
    case "npm":
    case "yarn":
      return ensurePackageJsonWorkspaceIncludesProject(projectRoot);
  }
}

function packageManagerRootOnlyPackageJsonPatch(
  packageManager: PackageManagerKind,
  input: {
    readonly aiPackageVersion?: string;
    readonly nodeEngineRequirement?: string;
  },
): PackageJsonPatch {
  const patch: PackageJsonPatch = {};
  if (input.nodeEngineRequirement !== undefined) {
    patch.nodeEngineRequirement = input.nodeEngineRequirement;
  }
  if (input.aiPackageVersion !== undefined) {
    switch (packageManager) {
      case "bun":
      case "npm":
        patch.overrides = { ai: input.aiPackageVersion };
        break;
      case "yarn":
        patch.resolutions = { ai: input.aiPackageVersion };
        break;
      case "pnpm":
        break;
    }
  }
  return patch;
}

/** Applies root-only package.json fields to an ancestor workspace package.json. */
export async function patchWorkspaceRootPackageJson(
  packageManager: PackageManagerKind,
  projectRoot: string,
  input: {
    readonly aiPackageVersion?: string;
    readonly nodeEngineRequirement?: string;
    readonly onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
  },
): Promise<WorkspaceRootPackageJsonPatchResult> {
  if (!isPackageManagerWorkspaceMember(packageManager, projectRoot)) {
    return { changed: false };
  }

  const path = workspaceRootPackageJsonPath(packageManager, projectRoot);
  if (path === undefined || !existsSync(path)) {
    return { changed: false };
  }

  const result = await patchPackageJson(
    path,
    packageManagerRootOnlyPackageJsonPatch(packageManager, input),
  );
  if (result.changed) {
    await input.onWorkspaceRootMutation?.({
      kind: "package-json",
      nodeEngineOverride: result.nodeEngineOverride,
      path,
    });
  }
  return { ...result, path };
}

/** Applies manager-owned project files and reports ancestor workspace mutations. */
export async function applyPackageManagerWorkspaceConfiguration(input: {
  readonly packageManager: PackageManagerKind;
  readonly projectRoot: string;
  readonly workspaceProbeRoot?: string;
  readonly onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
}): Promise<{
  filesSkipped: string[];
  filesWritten: string[];
}> {
  const workspaceProbeRoot = resolve(input.workspaceProbeRoot ?? input.projectRoot);
  const workspaceConfigPath =
    input.packageManager === "pnpm"
      ? undefined
      : await ensurePackageManagerWorkspaceIncludesProject(
          input.packageManager,
          workspaceProbeRoot,
        );
  const packageManagerResult = await getPackageManagerStrategy(
    input.packageManager,
  ).applyProjectConfiguration(input.projectRoot, { workspaceProbeRoot });
  const filesWritten = [
    ...(workspaceConfigPath === undefined ? [] : [workspaceConfigPath]),
    ...packageManagerResult.filesWritten,
  ];
  const filesSkipped = [...packageManagerResult.filesSkipped];

  for (const filePath of filesWritten) {
    if (!isPathInside(input.projectRoot, filePath)) {
      await input.onWorkspaceRootMutation?.({ kind: "workspace-config", path: filePath });
    }
  }

  return { filesSkipped, filesWritten };
}
