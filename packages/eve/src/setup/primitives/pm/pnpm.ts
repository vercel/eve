import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { pathExists } from "../../path-exists.js";

import type { PackageManagerStrategy } from "./types.js";

export const PNPM_WORKSPACE_PATH = "pnpm-workspace.yaml";
export const PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS = ["list", "--depth", "-1", "--json"] as const;
// eve@0.6.0-beta.13 through 0.7.0 imported `oxc-parser` at runtime while
// declaring it only as a devDependency. Fixed releases use their own manifest.
export const PNPM_WORKSPACE_CONTENT = [
  "minimumReleaseAgeExclude:",
  "  - eve",
  "allowBuilds:",
  "  sharp: false",
  "# Compatibility for eve releases with an incomplete runtime manifest.",
  "packageExtensions:",
  '  "eve@>=0.6.0-beta.13 <=0.7.0":',
  "    dependencies:",
  "      oxc-parser: 0.134.0",
  "",
].join("\n");

const EVE_RELEASE_AGE_EXCLUSION = "  - eve";
const SHARP_BUILD_POLICY = "  sharp: false";

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

function withExperimentalEveReleaseAgeExclusion(source: string): string {
  const normalized = source.endsWith("\n") ? source : `${source}\n`;
  const lines = normalized.split("\n");
  const excludeIndex = lines.findIndex((line) => line === "minimumReleaseAgeExclude:");

  if (excludeIndex < 0) {
    const prefix = normalized.trim().length === 0 ? "" : `${normalized}\n`;
    return `${prefix}minimumReleaseAgeExclude:\n${EVE_RELEASE_AGE_EXCLUSION}\n`;
  }

  const blockEnd = findYamlBlockEnd(lines, excludeIndex);
  const excludeBlock = lines.slice(excludeIndex + 1, blockEnd);
  if (excludeBlock.some((line) => line.trim() === "- eve")) {
    return source;
  }

  let insertAt = blockEnd;
  while (insertAt > excludeIndex + 1 && lines[insertAt - 1] === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, EVE_RELEASE_AGE_EXCLUSION);
  return lines.join("\n");
}

async function ensurePnpmWorkspacePolicy(filePath: string): Promise<"skipped" | "written"> {
  if (!(await pathExists(filePath))) {
    await writeFile(filePath, PNPM_WORKSPACE_CONTENT, "utf8");
    return "written";
  }

  const current = await readFile(filePath, "utf8");
  const next = withExperimentalEveReleaseAgeExclusion(withSharpBuildPolicy(current));
  if (next === current) {
    return "skipped";
  }

  await writeFile(filePath, next, "utf8");
  return "written";
}

/** Whether pnpm can walk from this project into a parent-owned workspace. */
export function hasAncestorPnpmWorkspace(projectRoot: string): boolean {
  let dir = dirname(resolve(projectRoot));
  while (true) {
    if (existsSync(join(dir, PNPM_WORKSPACE_PATH))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
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
  async applyProjectConfiguration(projectRoot) {
    const filePath = join(projectRoot, PNPM_WORKSPACE_PATH);
    const result = await ensurePnpmWorkspacePolicy(filePath);
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
