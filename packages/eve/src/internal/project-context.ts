import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { resolveAgentWorkspace, type AgentWorkspace } from "#internal/agent-workspace.js";
import { findEveProjectRoot } from "#internal/eve-project-root.js";

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

  const workspace = await resolveAgentWorkspace(projectRoot, { source });
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
