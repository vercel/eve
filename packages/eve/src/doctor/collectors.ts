import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveDiscoveryProject } from "#discover/project.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";
import { detectPackageManager } from "#setup/package-manager.js";

import type {
  DependencyFacts,
  DiscoveryFacts,
  GitFacts,
  NodeFacts,
  PackageManagerFacts,
  VercelFacts,
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
    const managers = lockfiles.map((name) =>
      name === "pnpm-lock.yaml"
        ? "pnpm"
        : name === "package-lock.json"
          ? "npm"
          : name === "yarn.lock"
            ? "yarn"
            : "bun",
    );
    return {
      kind: "observed",
      manager: manager.kind,
      source: manager.source,
      lockfiles,
      conflict: managers.some((observed) => observed !== manager.kind),
    };
  } catch (error) {
    return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function collectDependencyFacts(
  appRoot: string,
  manager: PackageManagerFacts,
): Promise<DependencyFacts> {
  try {
    const parsed = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
    if (dependencies.length === 0) return { kind: "not-applicable" };
    if (
      manager.kind === "observed" &&
      manager.manager === "yarn" &&
      (await pathExists(join(appRoot, ".pnp.cjs")))
    ) {
      return { kind: "installed" };
    }
    const missing = (
      await Promise.all(
        dependencies.map(async (name) =>
          (await pathExists(join(appRoot, "node_modules", name, "package.json")))
            ? undefined
            : name,
        ),
      )
    ).filter((name): name is string => name !== undefined);
    return missing.length === 0
      ? { kind: "installed" }
      : { kind: "missing", dependencies: missing };
  } catch (error) {
    return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

async function git(appRoot: string, args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { cwd: appRoot, timeout: 5_000 })).stdout.trim();
}

export async function collectGitFacts(appRoot: string): Promise<GitFacts> {
  try {
    const repository = await git(appRoot, ["rev-parse", "--is-inside-work-tree"]).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw error;
        return "false";
      },
    );
    if (repository !== "true") return { kind: "not-repository" };
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

export async function collectVercelFacts(
  workspaceRoot: string,
  offline: boolean,
): Promise<VercelFacts> {
  if (offline) return { kind: "skipped" };
  try {
    return { kind: await getVercelAuthStatus(workspaceRoot, { trustedCli: true }) };
  } catch {
    return { kind: "unavailable" };
  }
}
