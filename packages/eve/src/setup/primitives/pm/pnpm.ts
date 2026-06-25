import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { pathExists } from "../../path-exists.js";
import {
  workspacePatternForProject,
  workspacePatternsClaimProject,
} from "../../scaffold/workspace-glob.js";

import type { PackageManagerStrategy } from "./types.js";

export const PNPM_WORKSPACE_PATH = "pnpm-workspace.yaml";
export const PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS = ["list", "--depth", "-1", "--json"] as const;
const RELEASE_AGE_EXCLUSIONS = [
  "@ai-sdk/*",
  "@rolldown/*",
  "@vercel/*",
  "@workflow/*",
  "ai",
  "experimental-ai-sdk-code-mode",
  "eve",
  "nitro",
  "rolldown",
  "workflow",
] as const;

function formatReleaseAgeExclusion(exclusion: string): string {
  return `  - ${exclusion.includes("*") ? JSON.stringify(exclusion) : exclusion}`;
}

// eve@0.6.0-beta.13 through 0.7.0 imported `oxc-parser` at runtime while
// declaring it only as a devDependency. Fixed releases use their own manifest.
export const PNPM_WORKSPACE_CONTENT = [
  "minimumReleaseAgeExclude:",
  ...RELEASE_AGE_EXCLUSIONS.map(formatReleaseAgeExclusion),
  "allowBuilds:",
  "  sharp: false",
  "# Compatibility for eve releases with an incomplete runtime manifest.",
  "packageExtensions:",
  '  "eve@>=0.6.0-beta.13 <=0.7.0":',
  "    dependencies:",
  "      oxc-parser: 0.134.0",
  "",
].join("\n");

const SHARP_BUILD_POLICY = "  sharp: false";

function releaseAgeExclusionName(line: string): string {
  return line
    .trim()
    .replace(/^-\s+/u, "")
    .replace(/^["']|["']$/gu, "");
}

function findYamlBlockEnd(lines: readonly string[], startIndex: number): number {
  let blockEnd = startIndex + 1;
  while (blockEnd < lines.length) {
    const line = lines[blockEnd] ?? "";
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    blockEnd += 1;
  }
  return blockEnd;
}

function withSharpBuildPolicy(source: string): string {
  const normalized = source.endsWith("\n") ? source : `${source}\n`;
  const lines = normalized.split("\n");
  const allowBuildsIndex = lines.findIndex((line) => line === "allowBuilds:");

  if (allowBuildsIndex < 0) {
    const prefix = normalized.trim().length === 0 ? "" : `${normalized}\n`;
    return `${prefix}allowBuilds:\n${SHARP_BUILD_POLICY}\n`;
  }

  const blockEnd = findYamlBlockEnd(lines, allowBuildsIndex);
  const allowBuildsBlock = lines.slice(allowBuildsIndex + 1, blockEnd);
  if (allowBuildsBlock.some((line) => /^\s+sharp:/.test(line))) {
    return source;
  }

  let insertAt = blockEnd;
  while (insertAt > allowBuildsIndex + 1 && lines[insertAt - 1] === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, SHARP_BUILD_POLICY);
  return lines.join("\n");
}

function withReleaseAgeExclusions(source: string): string {
  const normalized = source.endsWith("\n") ? source : `${source}\n`;
  const lines = normalized.split("\n");
  const excludeIndex = lines.findIndex((line) => line === "minimumReleaseAgeExclude:");

  if (excludeIndex < 0) {
    const prefix = normalized.trim().length === 0 ? "" : `${normalized}\n`;
    const exclusions = RELEASE_AGE_EXCLUSIONS.map(formatReleaseAgeExclusion).join("\n");
    return `${prefix}minimumReleaseAgeExclude:\n${exclusions}\n`;
  }

  const blockEnd = findYamlBlockEnd(lines, excludeIndex);
  const excludeBlock = lines.slice(excludeIndex + 1, blockEnd);
  const existingExclusions = new Set(excludeBlock.map(releaseAgeExclusionName));
  const missingExclusions = RELEASE_AGE_EXCLUSIONS.filter(
    (exclusion) => !existingExclusions.has(exclusion),
  );
  if (missingExclusions.length === 0) {
    return source;
  }

  let insertAt = blockEnd;
  while (insertAt > excludeIndex + 1 && lines[insertAt - 1] === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, ...missingExclusions.map(formatReleaseAgeExclusion));
  return lines.join("\n");
}

async function ensurePnpmWorkspacePolicy(filePath: string): Promise<"skipped" | "written"> {
  if (!(await pathExists(filePath))) {
    await writeFile(filePath, PNPM_WORKSPACE_CONTENT, "utf8");
    return "written";
  }

  const current = await readFile(filePath, "utf8");
  const next = withReleaseAgeExclusions(withSharpBuildPolicy(current));
  if (next === current) {
    return "skipped";
  }

  await writeFile(filePath, next, "utf8");
  return "written";
}

/** Whether pnpm can walk from this project into a parent-owned workspace. */
export function findAncestorPnpmWorkspaceRoot(projectRoot: string): string | undefined {
  let dir = dirname(resolve(projectRoot));
  while (true) {
    if (existsSync(join(dir, PNPM_WORKSPACE_PATH))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether pnpm can walk from this project into a parent-owned workspace. */
export function hasAncestorPnpmWorkspace(projectRoot: string): boolean {
  return findAncestorPnpmWorkspaceRoot(projectRoot) !== undefined;
}

function parsePnpmWorkspacePackagePatterns(source: string): string[] | undefined {
  const lines = source.split(/\r?\n/u);
  const packagesIndex = lines.findIndex((line) => /^\s*packages:/u.test(line));
  if (packagesIndex < 0) return undefined;

  // This deliberately supports the common workspace shapes eve needs to edit:
  // a block sequence (`packages:\n  - apps/*`) and a simple inline sequence.
  // More complex YAML falls back to "unknown"; callers then treat the ancestor
  // as workspace-owned instead of creating nested standalone package-manager
  // state under an ambiguous monorepo.
  const inlineMatch = /^\s*packages:\s*\[(.*)\]\s*(?:#.*)?$/u.exec(lines[packagesIndex] ?? "");
  if (inlineMatch !== null) {
    const entries = inlineMatch[1]!.trim();
    if (entries.length === 0) return [];
    return entries
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ""))
      .filter((entry) => entry.length > 0);
  }

  if (lines[packagesIndex]?.trim() !== "packages:") return undefined;

  const patterns: string[] = [];
  for (const line of lines.slice(packagesIndex + 1)) {
    if (/^\S/u.test(line)) break;
    const match = /^\s*-\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    patterns.push(match[1]!.replace(/^['"]|['"]$/gu, ""));
  }
  return patterns;
}

/**
 * Returns the ancestor workspace root only when the workspace manifest's
 * package candidates include `projectRoot`. If the manifest cannot be parsed,
 * it is treated as a workspace owner so setup does not silently create nested
 * standalone package-manager state in an ambiguous monorepo.
 */
export function findClaimingAncestorPnpmWorkspaceRoot(projectRoot: string): string | undefined {
  const workspaceRoot = findAncestorPnpmWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined) return undefined;

  let patterns: string[] | undefined;
  try {
    patterns = parsePnpmWorkspacePackagePatterns(
      readFileSync(join(workspaceRoot, PNPM_WORKSPACE_PATH), "utf8"),
    );
  } catch {
    return workspaceRoot;
  }
  if (patterns === undefined) return workspaceRoot;

  return workspacePatternsClaimProject(patterns, workspaceRoot, projectRoot)
    ? workspaceRoot
    : undefined;
}

function withPnpmWorkspacePackagePattern(source: string, pattern: string): string {
  const normalized = source.endsWith("\n") ? source : `${source}\n`;
  const lines = normalized.split("\n");
  const packagesIndex = lines.findIndex((line) => line.trim() === "packages:");

  if (packagesIndex < 0) {
    const prefix = normalized.trim().length === 0 ? "" : `${normalized}\n`;
    return `${prefix}packages:\n  - ${pattern}\n`;
  }

  const blockEnd = findYamlBlockEnd(lines, packagesIndex);
  let insertAt = blockEnd;
  while (insertAt > packagesIndex + 1 && lines[insertAt - 1] === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, `  - ${pattern}`);
  return lines.join("\n");
}

export async function ensurePnpmWorkspaceIncludesProject(
  projectRoot: string,
): Promise<"skipped" | "written"> {
  const workspaceRoot = findAncestorPnpmWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined || resolve(workspaceRoot) === resolve(projectRoot)) {
    return "skipped";
  }
  if (findClaimingAncestorPnpmWorkspaceRoot(projectRoot) === workspaceRoot) {
    return "skipped";
  }

  const filePath = join(workspaceRoot, PNPM_WORKSPACE_PATH);
  const current = await readFile(filePath, "utf8");
  const next = withPnpmWorkspacePackagePattern(
    current,
    workspacePatternForProject(workspaceRoot, projectRoot),
  );
  if (next === current) return "skipped";
  await writeFile(filePath, next, "utf8");
  return "written";
}

/**
 * Reads `pnpm list --depth -1 --json` and answers whether the ancestor
 * workspace explicitly includes `projectRoot`. `undefined` means the output
 * was not trustworthy enough to choose an install mode.
 */
export function pnpmWorkspaceClaimsProject(
  stdout: string,
  projectRoot: string,
): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

  const canonicalPath = (path: string): string => {
    const absolute = resolve(path);
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  };
  const projectPath = canonicalPath(projectRoot);
  let sawProjectPath = false;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string") continue;
    sawProjectPath = true;
    if (canonicalPath(path) === projectPath) return true;
  }
  return sawProjectPath ? false : undefined;
}

export const pnpmPackageManager = {
  kind: "pnpm",
  scaffoldFiles: { [PNPM_WORKSPACE_PATH]: PNPM_WORKSPACE_CONTENT },
  async applyProjectConfiguration(projectRoot, options) {
    const workspaceProbeRoot = options?.workspaceProbeRoot ?? projectRoot;
    const workspaceMembershipResult = await ensurePnpmWorkspaceIncludesProject(workspaceProbeRoot);
    const workspaceRoot = findClaimingAncestorPnpmWorkspaceRoot(workspaceProbeRoot);
    const filePath = join(workspaceRoot ?? projectRoot, PNPM_WORKSPACE_PATH);
    const policyResult = await ensurePnpmWorkspacePolicy(filePath);
    const result =
      workspaceMembershipResult === "written" || policyResult === "written" ? "written" : "skipped";
    return result === "written"
      ? { filesSkipped: [], filesWritten: [filePath] }
      : { filesSkipped: [filePath], filesWritten: [] };
  },
  devArguments: () => ["exec", "eve", "dev"],
  installArguments: (options) => [
    "install",
    "--no-frozen-lockfile",
    ...(options.bypassMinimumReleaseAge === true ? ["--config.minimum-release-age=0"] : []),
    ...(options.ignoreWorkspace === true ? ["--ignore-workspace"] : []),
  ],
  prepareArguments: (projectRoot, args) => ["--dir", projectRoot, ...args],
  resolveInvocation(args) {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath !== undefined && npmExecPath.toLowerCase().includes("pnpm")) {
      const extension = extname(npmExecPath).toLowerCase();
      if (extension === ".cjs" || extension === ".js") {
        return { args: [npmExecPath, ...args], command: process.execPath };
      }
      return { args, command: npmExecPath, shell: process.platform === "win32" };
    }

    if (process.env.npm_config_user_agent?.toLowerCase().startsWith("pnpm/")) {
      return { args, command: "pnpm", shell: process.platform === "win32" };
    }

    const pnpmHome = process.env.PNPM_HOME;
    if (pnpmHome !== undefined) {
      const command = join(pnpmHome, process.platform === "win32" ? "pnpm.CMD" : "pnpm");
      if (existsSync(command)) {
        return { args, command, shell: process.platform === "win32" };
      }
    }

    return { args, command: "pnpm" };
  },
} satisfies PackageManagerStrategy;
