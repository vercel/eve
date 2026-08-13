import { join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { parseJsonObject } from "#shared/json.js";

const AGENTS_DIRECTORY = "agents";

export interface AgentWorkspaceMember {
  readonly appRoot: string;
  readonly name: string;
}

export interface AgentWorkspace {
  readonly members: readonly AgentWorkspaceMember[];
  readonly root: string;
}

async function declaresAgentWorkspace(source: ProjectSource, root: string): Promise<boolean> {
  const packageJsonPath = join(root, "package.json");
  if ((await source.stat(packageJsonPath)) !== "file") return false;

  const packageJson = parseJsonObject(JSON.parse(await source.readTextFile(packageJsonPath)));
  const eve = packageJson.eve;
  if (typeof eve !== "object" || eve === null || Array.isArray(eve)) return false;

  const agents = (eve as Record<string, unknown>).agents;
  return Array.isArray(agents) && agents.length === 1 && agents[0] === "agents/*";
}

/** Materialize and validate a declared, strict direct-child `agents/<name>/agent/` workspace. */
export async function resolveAgentWorkspace(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<AgentWorkspace | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const workspaceRoot = resolve(root);
  if (!(await declaresAgentWorkspace(source, workspaceRoot))) return undefined;

  const agentsRoot = join(workspaceRoot, AGENTS_DIRECTORY);
  if ((await source.stat(agentsRoot)) !== "directory") {
    throw new Error("An eve agent workspace requires an agents/ directory.");
  }
  if ((await source.stat(join(workspaceRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both root agent/ and agents/. Move the root agent under agents/<name>/ or remove the workspace.",
    );
  }

  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) {
    throw new Error("The agents/ workspace must contain at least one direct child agent.");
  }

  const members: AgentWorkspaceMember[] = [];
  for (const entry of directories) {
    assertValidPublicAgentName(entry.name, "Agent workspace member");
    const appRoot = join(agentsRoot, entry.name);
    if ((await source.stat(join(appRoot, "agent"))) !== "directory") {
      const flatHint =
        (await source.stat(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name)} is not a workspace agent: expected ${join(AGENTS_DIRECTORY, entry.name, "agent")}/.${flatHint}`,
      );
    }
    if ((await source.stat(join(appRoot, "package.json"))) === "file") {
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name, "package.json")} is not supported in an eve agent workspace. Define dependencies and build scripts at the workspace root.`,
      );
    }

    members.push({ appRoot, name: entry.name });
  }

  return { members, root: workspaceRoot };
}
