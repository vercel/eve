import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
      readonly member: AgentWorkspace["members"][number];
    }
  | {
      readonly appRoot: string;
      readonly environmentRoot: string;
      readonly kind: "standalone";
    };

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveWorkspace(root: string, source: ProjectSource): Promise<AgentWorkspace> {
  const agentsRoot = join(root, "agents");
  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const members = entries.map((entry) => {
    assertValidPublicAgentName(entry.name, "Agent workspace member");
    return { appRoot: join(agentsRoot, entry.name), name: entry.name };
  });
  return { members, root };
}

/** Resolve the owning eve package, validate its shape, and classify the input path within it. */
export async function resolveEveProjectContext(
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
  if (hasAgent === hasAgents) {
    const detail = hasAgent ? "both agent/ and agents/" : "neither agent/ nor agents/";
    throw new Error(`Invalid eve project at ${projectRoot}: found ${detail}.`);
  }

  if (hasAgent) {
    return { appRoot: projectRoot, environmentRoot: projectRoot, kind: "standalone" };
  }

  const workspace = await resolveWorkspace(projectRoot, source);
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
