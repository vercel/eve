import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { parseJsonObject } from "#shared/json.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { packageManagerWorkspaceClaimsProject } from "#setup/workspace-membership.js";

export interface AgentWorkspaceMember {
  readonly appRoot: string;
  readonly name: string;
  readonly packageJsonPath?: string;
}

export interface AgentWorkspace {
  readonly members: readonly AgentWorkspaceMember[];
  readonly root: string;
}

function parseAgentPatterns(
  source: ProjectSource,
  root: string,
): Promise<readonly string[] | undefined> {
  return (async () => {
    const packageJsonPath = join(root, "package.json");
    if ((await source.stat(packageJsonPath)) !== "file") return undefined;

    const packageJson = parseJsonObject(JSON.parse(await source.readTextFile(packageJsonPath)));
    const eve = packageJson.eve;
    if (typeof eve !== "object" || eve === null || Array.isArray(eve)) return undefined;

    const agents = (eve as Record<string, unknown>).agents;
    if (agents === undefined) return undefined;
    if (
      !Array.isArray(agents) ||
      agents.length === 0 ||
      agents.some((agent) => typeof agent !== "string")
    ) {
      throw new Error(
        "package.json eve.agents must be a non-empty array of workspace-relative paths or glob patterns.",
      );
    }

    return agents as readonly string[];
  })();
}

function parseAgentPattern(pattern: string): readonly string[] {
  if (pattern.length === 0 || isAbsolute(pattern) || pattern.includes("\\")) {
    throw new Error(
      `eve.agents entry ${JSON.stringify(pattern)} must be a non-empty workspace-relative path or glob pattern.`,
    );
  }

  const segments = pattern.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(
      `eve.agents entry ${JSON.stringify(pattern)} must not contain empty, ".", or ".." path segments.`,
    );
  }
  if (segments.some((segment) => !/^[A-Za-z0-9_.*-]+$/.test(segment))) {
    throw new Error(
      `eve.agents entry ${JSON.stringify(pattern)} contains unsupported glob syntax. Use path segments with letters, numbers, "_", "-", "*", or "**".`,
    );
  }

  return segments;
}

function matchesSegment(pattern: string, name: string): boolean {
  if (pattern === "**") return true;
  const expression = pattern.replaceAll(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${expression}$`).test(name);
}

async function resolveAgentPattern(
  source: ProjectSource,
  root: string,
  pattern: string,
): Promise<readonly string[]> {
  const segments = parseAgentPattern(pattern);
  const matches = new Set<string>();

  async function visit(directory: string, segmentIndex: number): Promise<void> {
    if (segmentIndex === segments.length) {
      if ((await source.stat(directory)) === "directory") matches.add(directory);
      return;
    }

    const segment = segments[segmentIndex]!;
    if (segment === "**") {
      await visit(directory, segmentIndex + 1);
      const entries = await source.readDirectory(directory);
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => visit(join(directory, entry.name), segmentIndex)),
      );
      return;
    }

    if (!segment.includes("*")) {
      const child = join(directory, segment);
      if ((await source.stat(child)) === "directory") await visit(child, segmentIndex + 1);
      return;
    }

    const entries = await source.readDirectory(directory);
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            matchesSegment(segment, entry.name),
        )
        .map((entry) => visit(join(directory, entry.name), segmentIndex + 1)),
    );
  }

  await visit(root, 0);
  const resolved = [...matches].sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)),
  );
  if (resolved.length === 0) {
    throw new Error(
      `eve.agents entry ${JSON.stringify(pattern)} did not match an agent directory.`,
    );
  }
  return resolved;
}

/** Materialize and validate the agent application roots declared in `package.json#eve.agents`. */
export async function resolveAgentWorkspace(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<AgentWorkspace | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const workspaceRoot = resolve(root);
  const patterns = await parseAgentPatterns(source, workspaceRoot);
  if (patterns === undefined) return undefined;

  if ((await source.stat(join(workspaceRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both root agent/ and declared eve.agents members. Move the root agent into the workspace or remove eve.agents.",
    );
  }

  const appRoots = new Set<string>();
  for (const pattern of patterns) {
    for (const appRoot of await resolveAgentPattern(source, workspaceRoot, pattern)) {
      appRoots.add(appRoot);
    }
  }

  const packageManager =
    source.kind === "disk" ? await detectPackageManager(workspaceRoot) : undefined;
  const members: AgentWorkspaceMember[] = [];
  const names = new Set<string>();
  for (const appRoot of [...appRoots].sort((left, right) =>
    relative(workspaceRoot, left).localeCompare(relative(workspaceRoot, right)),
  )) {
    const name = basename(appRoot);
    assertValidPublicAgentName(name, "Agent workspace member");
    if (names.has(name)) {
      throw new Error(
        `eve.agents resolves multiple agent directories named ${JSON.stringify(name)}. Use paths with distinct final directory names.`,
      );
    }
    names.add(name);

    if ((await source.stat(join(appRoot, "agent"))) !== "directory") {
      const relativeAppRoot = relative(workspaceRoot, appRoot);
      const flatHint =
        (await source.stat(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${relativeAppRoot} is not a workspace agent: expected ${join(relativeAppRoot, "agent")}/.${flatHint}`,
      );
    }

    const packageJsonPath = join(appRoot, "package.json");
    const hasPackageJson = (await source.stat(packageJsonPath)) === "file";
    if (
      source.kind === "disk" &&
      hasPackageJson &&
      !packageManagerWorkspaceClaimsProject(packageManager!.kind, workspaceRoot, appRoot)
    ) {
      throw new Error(
        `${join(relative(workspaceRoot, appRoot), "package.json")} defines a child package that is not a member of the root ${packageManager!.kind} workspace. Add a matching workspace pattern to the workspace configuration.`,
      );
    }

    members.push(hasPackageJson ? { appRoot, name, packageJsonPath } : { appRoot, name });
  }

  return { members, root: workspaceRoot };
}

/** Load a workspace that the caller has already identified as workspace-shaped. */
export async function loadAgentWorkspace(root: string): Promise<AgentWorkspace> {
  const workspace = await resolveAgentWorkspace(root);
  if (workspace === undefined) {
    throw new Error("An eve agent workspace requires package.json eve.agents.");
  }
  return workspace;
}
