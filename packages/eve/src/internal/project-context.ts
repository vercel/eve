import { basename, dirname, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import {
  resolveAgentCollection,
  type AgentCollection,
  type AgentCollectionMember,
} from "#internal/agent-collection.js";

export type EveProjectContext =
  | {
      readonly collection: AgentCollection;
      readonly environmentRoots: readonly string[];
      readonly kind: "collection";
    }
  | {
      readonly collection: AgentCollection;
      readonly environmentRoots: readonly string[];
      readonly kind: "collection-member";
      readonly member: AgentCollectionMember;
    }
  | {
      readonly appRoot: string;
      readonly environmentRoots: readonly string[];
      readonly kind: "standalone";
    };

function standalone(appRoot: string): Extract<EveProjectContext, { kind: "standalone" }> {
  return { appRoot, environmentRoots: [appRoot], kind: "standalone" };
}

/** Classify a direct `agents/<name>` root using the canonical ownership rules. */
export async function resolveNamedAgentProjectContext(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<Extract<EveProjectContext, { kind: "collection-member" | "standalone" }> | undefined> {
  const resolvedAppRoot = resolve(appRoot);
  const agentsRoot = dirname(resolvedAppRoot);
  if (basename(agentsRoot) !== "agents") return undefined;

  const source = options.source ?? createDiskProjectSource();
  const collectionRoot = dirname(agentsRoot);
  const collection = await resolveAgentCollection(collectionRoot, { source });
  const member = collection?.members.find((candidate) => candidate.appRoot === resolvedAppRoot);
  return collection === undefined || member === undefined
    ? undefined
    : {
        collection,
        environmentRoots: [collection.root, member.appRoot],
        kind: "collection-member",
        member,
      };
}

/** Classify the current filesystem scope before command-specific policy runs. */
export async function resolveEveProjectContext(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<EveProjectContext> {
  const resolvedAppRoot = resolve(appRoot);
  const source = options.source ?? createDiskProjectSource();
  const namedAgent = await resolveNamedAgentProjectContext(resolvedAppRoot, { source });
  if (namedAgent !== undefined) return namedAgent;

  const collection = await resolveAgentCollection(resolvedAppRoot, { source });
  return collection === undefined
    ? standalone(resolvedAppRoot)
    : { collection, environmentRoots: [collection.root], kind: "collection" };
}
