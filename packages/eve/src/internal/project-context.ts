import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { getDirectoryEntryType, isDiscoverableAgentRootEntry } from "#discover/filesystem.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { findEveProjectRoot } from "#internal/eve-project-root.js";

export interface AgentWorkspaceMember {
  readonly appRoot: string;
  readonly name: string;
}

export interface AgentWorkspace {
  readonly members: readonly AgentWorkspaceMember[];
  readonly root: string;
}

export type EveProjectContext =
  | {
      readonly workspace: AgentWorkspace;
      readonly environmentRoot: string;
      readonly kind: "workspace";
    }
  | {
      readonly workspace: AgentWorkspace;
      readonly environmentRoot: string;
      readonly kind: "workspace-member";
      readonly member: AgentWorkspaceMember;
    }
  | {
      readonly appRoot: string;
      readonly environmentRoot: string;
      readonly kind: "standalone";
    };

function containsPath(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function hasFlatAgentRoot(root: string, source: ProjectSource): Promise<boolean> {
  const entries = await source.readDirectory(root);
  return entries.some((entry) =>
    isDiscoverableAgentRootEntry(entry.name, getDirectoryEntryType(entry)),
  );
}

async function isWorkspaceOwnedAgentRoot(appRoot: string, source: ProjectSource): Promise<boolean> {
  if ((await source.stat(join(appRoot, "package.json"))) === "file") return false;
  if ((await source.stat(join(appRoot, "agent"))) === "directory") return true;
  return hasFlatAgentRoot(appRoot, source);
}

async function resolveWorkspace(root: string, source: ProjectSource): Promise<AgentWorkspace> {
  const agentsRoot = join(root, "agents");
  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const members: AgentWorkspaceMember[] = [];
  for (const entry of entries) {
    const appRoot = join(agentsRoot, entry.name);
    if (!(await isWorkspaceOwnedAgentRoot(appRoot, source))) continue;
    assertValidPublicAgentName(entry.name, "Agent workspace member");
    members.push({ appRoot, name: entry.name });
  }
  return { members, root };
}

/** Try to resolve the owning eve package and classify the input path within it. */
export async function findEveProjectContext(
  startPath: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<EveProjectContext | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const resolvedStartPath = resolve(startPath);
  const searchDirectory =
    (await source.stat(resolvedStartPath)) === "directory"
      ? resolvedStartPath
      : dirname(resolvedStartPath);
  const projectRoot = await findEveProjectRoot(searchDirectory, { source });
  if (projectRoot === undefined) return undefined;

  const hasAgent = (await source.stat(join(projectRoot, "agent"))) === "directory";
  const hasAgents = (await source.stat(join(projectRoot, "agents"))) === "directory";
  if (hasAgent) {
    return { appRoot: projectRoot, environmentRoot: projectRoot, kind: "standalone" };
  }

  if (hasAgents) {
    const workspace = await resolveWorkspace(projectRoot, source);
    if (workspace.members.length > 0) {
      const member = workspace.members.find((candidate) =>
        containsPath(candidate.appRoot, searchDirectory),
      );
      if (member !== undefined) {
        return {
          workspace,
          environmentRoot: workspace.root,
          kind: "workspace-member",
          member,
        };
      }

      return { workspace, environmentRoot: workspace.root, kind: "workspace" };
    }
  }

  if (await hasFlatAgentRoot(projectRoot, source)) {
    return { appRoot: projectRoot, environmentRoot: projectRoot, kind: "standalone" };
  }
  if (hasAgents) {
    return {
      workspace: { members: [], root: projectRoot },
      environmentRoot: projectRoot,
      kind: "workspace",
    };
  }
  throw new Error(`Invalid eve project at ${projectRoot}: found no agent files.`);
}

/** Resolve the owning eve project, throwing when the path has no eve package owner. */
export async function resolveEveProjectContext(
  startPath: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<EveProjectContext> {
  const context = await findEveProjectContext(startPath, options);
  if (context === undefined) {
    throw new Error(`No eve project contains ${resolve(startPath)}.`);
  }
  return context;
}
