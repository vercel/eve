import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import type { CompiledAgentManifest, CompiledAgentResources } from "#compiler/manifest.js";
import { workspaceResourceLogicalPath } from "#shared/workspace-resource-identity.js";

export interface CompiledSandboxInheritanceSemanticIssue {
  readonly message: string;
  readonly path: readonly (number | string)[];
}

/** Collects graph relations required by a sandbox that delegates to its parent. */
export function collectCompiledSandboxInheritanceSemanticIssues(
  manifest: CompiledAgentManifest,
): readonly CompiledSandboxInheritanceSemanticIssue[] {
  const issues: CompiledSandboxInheritanceSemanticIssue[] = [];
  const parentNodeIds = new Map(
    manifest.subagentEdges.map((edge) => [edge.childNodeId, edge.parentNodeId] as const),
  );
  const nodes = [
    {
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      path: [] as const,
      resources: manifest as CompiledAgentResources,
    },
    ...manifest.subagents.map((subagent, index) => ({
      nodeId: subagent.nodeId,
      path: ["subagents", index, "agent"] as const,
      resources: subagent.agent,
    })),
  ];

  for (const node of nodes) {
    if (node.resources.sandbox.inheritsParent !== true) continue;
    const path = [...node.path, "sandbox", "inheritsParent"];
    if (
      node.nodeId === ROOT_COMPILED_AGENT_NODE_ID ||
      parentNodeIds.get(node.nodeId) === undefined
    ) {
      issues.push({
        message: `Compiled sandbox "${node.resources.sandbox.logicalPath}" selects parent.sandbox but agent node "${node.nodeId}" has no parent.`,
        path,
      });
    }
    if (node.resources.dynamicSkills.length > 0) {
      issues.push({
        message: `Compiled sandbox "${node.resources.sandbox.logicalPath}" selects parent.sandbox but agent node "${node.nodeId}" defines dynamic skills. Remove the child dynamic skills or give the child its own sandbox.`,
        path,
      });
    }
    if (hasManagedWorkspaceResources(node.resources)) {
      issues.push({
        message: `Compiled sandbox "${node.resources.sandbox.logicalPath}" selects parent.sandbox but has managed workspace resources. Remove the child workspace or give the child its own sandbox.`,
        path,
      });
    }
  }

  return issues;
}

/** Validates sandbox inheritance before module hydration at every artifact boundary. */
export function assertCompiledSandboxInheritanceSemantics(manifest: CompiledAgentManifest): void {
  const issues = collectCompiledSandboxInheritanceSemanticIssues(manifest);
  if (issues.length === 0) return;
  throw new Error(issues.map((issue) => issue.message).join("\n"));
}

/** Validates one node's canonical compiled workspace-resource descriptor. */
export function assertWorkspaceResourceRootSemantics(
  resources: CompiledAgentResources,
  options: {
    readonly nodeId: string;
    readonly requireContentHash: boolean;
  },
): void {
  const expectedLogicalPath = workspaceResourceLogicalPath(options.nodeId);
  if (resources.workspaceResourceRoot.logicalPath !== expectedLogicalPath) {
    throw new Error(
      `Compiled node "${options.nodeId}" workspace resource path "${resources.workspaceResourceRoot.logicalPath}" does not match canonical path "${expectedLogicalPath}".`,
    );
  }
  for (const workspace of resources.sandboxWorkspaces) {
    assertCanonicalWorkspaceRootEntries(workspace.rootEntries, options.nodeId);
  }
  assertCanonicalWorkspaceRootEntries(resources.workspaceResourceRoot.rootEntries, options.nodeId);
  const expectedRootEntries = deriveResourceRootEntries({
    sandboxWorkspaces: resources.sandboxWorkspaces,
  });
  if (!sameStrings(resources.workspaceResourceRoot.rootEntries, expectedRootEntries)) {
    throw new Error(
      `Compiled node "${options.nodeId}" workspace resource entries do not match its compiled workspace sources.`,
    );
  }
  if (
    options.requireContentHash &&
    resources.workspaceResourceRoot.contentHash === undefined &&
    (resources.skills.length > 0 || resources.workspaceResourceRoot.rootEntries.length > 0)
  ) {
    throw new Error(
      `Compiled node "${options.nodeId}" has managed workspace resources but no compiled contentHash.`,
    );
  }
}

/** Computes the sorted workspace entries seeded for one graph node. */
export function deriveResourceRootEntries(input: {
  readonly sandboxWorkspaces?: readonly { readonly rootEntries: readonly string[] }[];
}): readonly string[] {
  const rootEntries = new Set<string>();

  for (const workspace of input.sandboxWorkspaces ?? []) {
    for (const entry of workspace.rootEntries) {
      rootEntries.add(entry);
    }
  }

  return [...rootEntries].sort((left, right) => left.localeCompare(right));
}

function assertCanonicalWorkspaceRootEntries(entries: readonly string[], nodeId: string): void {
  let previous: string | undefined;
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      throw new Error(`Compiled node "${nodeId}" has invalid workspace root entry "${entry}".`);
    }
    if (names.has(name) || (previous !== undefined && previous.localeCompare(entry) >= 0)) {
      throw new Error(
        `Compiled node "${nodeId}" workspace root entries are not unique and canonically sorted.`,
      );
    }
    names.add(name);
    previous = entry;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasManagedWorkspaceResources(resources: CompiledAgentResources): boolean {
  return (
    resources.skills.length > 0 ||
    resources.workspaceResourceRoot.contentHash !== undefined ||
    resources.workspaceResourceRoot.rootEntries.length > 0
  );
}
