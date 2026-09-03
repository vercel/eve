import { basename, join, relative, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";

export interface AgentWorkspaceMember {
  readonly appRoot: string;
  readonly name: string;
}

export interface AgentWorkspace {
  readonly members: readonly AgentWorkspaceMember[];
  readonly root: string;
}

/** Load and validate a root already known to have an `agents/` workspace shape. */
export async function resolveAgentWorkspace(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<AgentWorkspace> {
  const source = options.source ?? createDiskProjectSource();
  const workspaceRoot = resolve(root);
  const agentsRoot = join(workspaceRoot, "agents");
  if ((await source.stat(agentsRoot)) !== "directory") {
    throw new Error("An eve agent workspace requires an agents/ directory.");
  }

  if ((await source.stat(join(workspaceRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both agent/ and agents/. Keep a standalone agent or move it into the workspace.",
    );
  }

  const members: AgentWorkspaceMember[] = [];
  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const appRoot = join(agentsRoot, entry.name);
    const name = basename(appRoot);
    assertValidPublicAgentName(name, "Agent workspace member");
    if ((await source.stat(join(appRoot, "agent"))) !== "directory") {
      const relativeAppRoot = relative(workspaceRoot, appRoot).replaceAll("\\", "/");
      const flatHint =
        (await source.stat(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${relativeAppRoot} is not a workspace agent: expected ${relativeAppRoot}/agent/.${flatHint}`,
      );
    }
    members.push({ appRoot, name });
  }

  if (members.length === 0) {
    throw new Error("An eve agent workspace requires at least one directory under agents/.");
  }

  return { members, root: workspaceRoot };
}
