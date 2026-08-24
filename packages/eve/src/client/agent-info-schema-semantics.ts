import { z } from "#compiled/zod/index.js";
import { owner, remoteAgent, source, localSubagent } from "#client/agent-info-resource-schemas.js";
import { parseEveRoutePattern } from "#protocol/route-pattern.js";

export function validateAgentGraph(
  result: {
    readonly agent: { readonly nodeId: string };
    readonly remoteAgents: { readonly entries: readonly z.output<typeof remoteAgent>[] };
    readonly subagents: { readonly local: readonly z.output<typeof localSubagent>[] };
  },
  context: z.RefinementCtx,
): void {
  const localEntries = result.subagents.local.map((entry, index) => ({
    entry,
    path: ["subagents", "local", index] as const,
  }));
  const remoteEntries = result.remoteAgents.entries.map((entry, index) => ({
    entry,
    path: ["remoteAgents", "entries", index] as const,
  }));
  const graphEntries = [...localEntries, ...remoteEntries];

  addDuplicateIssues(
    [
      { identity: result.agent.nodeId, path: ["agent", "nodeId"] as const },
      ...graphEntries.map(({ entry, path }) => ({ identity: entry.nodeId, path })),
    ],
    "Root, local, and remote agent node identities must be unique.",
    context,
  );
  addDuplicateIssues(
    graphEntries.map(({ entry, path }) => ({
      identity: `${entry.parentNodeId}\0${entry.name}`,
      path,
    })),
    "Local and remote agent names must be unique within each parent scope.",
    context,
  );

  const localsByNodeId = new Map(localEntries.map(({ entry }) => [entry.nodeId, entry] as const));
  for (const { entry, path } of graphEntries) {
    if (entry.parentNodeId === result.agent.nodeId) continue;
    if (!localsByNodeId.has(entry.parentNodeId)) {
      addCustomIssue(
        "Every local and remote agent parent must be the root agent or a projected local agent.",
        [...path, "parentNodeId"],
        context,
      );
    }
  }

  for (const { entry, path } of localEntries) {
    const ancestors = new Set<string>([entry.nodeId]);
    let parentNodeId = entry.parentNodeId;
    while (parentNodeId !== result.agent.nodeId) {
      if (ancestors.has(parentNodeId)) {
        addCustomIssue(
          "Every local agent ancestry chain must terminate at the root agent without a cycle.",
          [...path, "parentNodeId"],
          context,
        );
        break;
      }
      ancestors.add(parentNodeId);
      const parent = localsByNodeId.get(parentNodeId);
      if (parent === undefined) break;
      parentNodeId = parent.parentNodeId;
    }
  }
}

export function addDuplicateIssues(
  entries: readonly {
    readonly identity: string;
    readonly path: readonly (number | string)[];
  }[],
  message: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!seen.has(entry.identity)) {
      seen.add(entry.identity);
      continue;
    }
    context.addIssue({
      code: "custom",
      message,
      path: [...entry.path],
    });
  }
}

export function addCustomIssue(
  message: string,
  path: readonly (number | string)[],
  context: z.RefinementCtx,
): void {
  context.addIssue({ code: "custom", message, path: [...path] });
}

export function readRouteIdentity(
  method: string,
  pathPattern: string,
  path: readonly (number | string)[],
  context: z.RefinementCtx,
): string | undefined {
  try {
    const parsed = parseEveRoutePattern(pathPattern);
    if (parsed.canonicalPath !== pathPattern) {
      addCustomIssue("Channel route paths must use their canonical form.", path, context);
    }
    return `${method}\0${parsed.identityPattern}`;
  } catch {
    addCustomIssue("Channel route paths must use a valid eve route pattern.", path, context);
    return undefined;
  }
}

export function sameSourceProjection(left: AgentInfoSource, right: AgentInfoSource): boolean {
  return (
    left.exportName === right.exportName &&
    left.logicalPath === right.logicalPath &&
    ownerIdentity(left.owner) === ownerIdentity(right.owner) &&
    left.sourceId === right.sourceId &&
    left.sourceKind === right.sourceKind
  );
}

export function slotBelongsToFamily(slot: string, family: string, allowRoot: boolean): boolean {
  return slot.startsWith(`${family}/`) || (allowRoot && slot === family);
}

function ownerIdentity(ownerValue: AgentInfoOwner): string {
  switch (ownerValue.kind) {
    case "application":
      return "application";
    case "framework":
      return `framework\0${ownerValue.feature}`;
    case "extension":
      return `extension\0${ownerValue.namespace}\0${ownerValue.packageName}`;
  }
}

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

type AgentInfoOwner = ReadonlyDeep<z.output<typeof owner>>;
type AgentInfoSource = ReadonlyDeep<z.output<typeof source>>;
