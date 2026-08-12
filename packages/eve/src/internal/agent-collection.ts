import { join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { parseJsonObject } from "#shared/json.js";

const AGENTS_DIRECTORY = "agents";

export interface AgentCollectionMember {
  readonly appRoot: string;
  readonly name: string;
}

export interface AgentCollection {
  readonly members: readonly AgentCollectionMember[];
  readonly root: string;
}

async function declaresAgentCollection(source: ProjectSource, root: string): Promise<boolean> {
  const packageJsonPath = join(root, "package.json");
  if ((await source.stat(packageJsonPath)) !== "file") return false;

  const packageJson = parseJsonObject(JSON.parse(await source.readTextFile(packageJsonPath)));
  const eve = packageJson.eve;
  return (
    typeof eve === "object" &&
    eve !== null &&
    !Array.isArray(eve) &&
    (eve as Record<string, unknown>).collection === true
  );
}

/** Materialize and validate a declared, strict direct-child `agents/<name>/agent/` collection. */
export async function resolveAgentCollection(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<AgentCollection | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const collectionRoot = resolve(root);
  if (!(await declaresAgentCollection(source, collectionRoot))) return undefined;

  const agentsRoot = join(collectionRoot, AGENTS_DIRECTORY);
  if ((await source.stat(agentsRoot)) !== "directory") {
    throw new Error("An eve agent collection requires an agents/ directory.");
  }
  if ((await source.stat(join(collectionRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both root agent/ and agents/. Move the root agent under agents/<name>/ or remove the collection.",
    );
  }

  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) {
    throw new Error("The agents/ collection must contain at least one direct child agent.");
  }

  const members: AgentCollectionMember[] = [];
  for (const entry of directories) {
    assertValidPublicAgentName(entry.name, "Agent collection member");
    const appRoot = join(agentsRoot, entry.name);
    if ((await source.stat(join(appRoot, "agent"))) !== "directory") {
      const flatHint =
        (await source.stat(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name)} is not a collection agent: expected ${join(AGENTS_DIRECTORY, entry.name, "agent")}/.${flatHint}`,
      );
    }
    if ((await source.stat(join(appRoot, "package.json"))) === "file") {
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name, "package.json")} is not supported in an eve agent collection. Define dependencies and build scripts at the collection root.`,
      );
    }

    members.push({ appRoot, name: entry.name });
  }

  return { members, root: collectionRoot };
}
