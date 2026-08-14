import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveDiscoveryProject } from "#discover/project.js";
import { detectPackageManager } from "#setup/package-manager.js";

import type {
  DependencyFacts,
  DiscoveryFacts,
  GitFacts,
  NodeFacts,
  PackageManagerFacts,
} from "./types.js";

const runFile = promisify(execFile);
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export async function collectDiscoveryFacts(path: string): Promise<DiscoveryFacts> {
  try {
    return { kind: "resolved", project: await resolveDiscoveryProject(path) };
  } catch (error) {
    return { kind: "unresolved", message: error instanceof Error ? error.message : String(error) };
  }
}

export function collectNodeFacts(): NodeFacts {
  return process.execPath === ""
    ? { kind: "unavailable", message: "Node.js executable is unavailable." }
    : { kind: "available", executable: process.execPath, version: process.versions.node };
}

export async function collectPackageManagerFacts(appRoot: string): Promise<PackageManagerFacts> {
  try {
    const manager = await detectPackageManager(appRoot);
    const entries = new Set(await readdir(appRoot));
    const lockfiles = LOCKFILES.filter((name) => entries.has(name));
    const managers = new Set(
      lockfiles.map((name) =>
        name === "pnpm-lock.yaml"
          ? "pnpm"
          : name === "package-lock.json"
            ? "npm"
            : name === "yarn.lock"
              ? "yarn"
              : "bun",
      ),
    );
    return {
      kind: "observed",
      manager: manager.kind,
      source: manager.source,
      lockfiles,
      conflict: managers.size > 1,
    };
  } catch (error) {
    return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectDependencyFacts(appRoot: string): Promise<DependencyFacts> {
  try {
    const packageJsonPath = join(appRoot, "package.json");
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
    if (names.length === 0) return { kind: "not-applicable" };
    await access(join(appRoot, "node_modules"));
    return { kind: "installed" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

async function git(appRoot: string, args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { cwd: appRoot, timeout: 5_000 })).stdout.trim();
}

export async function collectGitFacts(appRoot: string): Promise<GitFacts> {
  try {
    if (
      (await git(appRoot, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")) !== "true"
    ) {
      return { kind: "not-repository" };
    }
    const revision = await git(appRoot, ["rev-parse", "HEAD"]).catch(() => undefined);
    const branch = await git(appRoot, ["symbolic-ref", "--short", "HEAD"]).catch(() => undefined);
    const remotes = (await git(appRoot, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
    return {
      kind: "repository",
      head: revision === undefined ? "unborn" : branch === undefined ? "detached" : "attached",
      branch,
      revision,
      dirty: (await git(appRoot, ["status", "--porcelain"])) !== "",
      remotes,
    };
  } catch (error) {
    return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}
