import type { CompiledAgentNodeManifest, CompiledSubagentNode } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import type {
  EffectiveAgentNodeSourceGraph,
  EffectiveAgentSourceCandidate,
} from "#compiler/effective-agent-source-graph.js";
import type { CompiledExternalDependencyRequest } from "#compiler/external-dependency-plan.js";
import type { CompiledExternalDependencyScope } from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { assertCompiledSourceBackingSemantics } from "#compiler/module-binding-semantics.js";

/** Derives the exact owner scopes that declared external executable packages. */
export function collectExternalDependencyRequests(
  root: CompiledAgentNodeManifest,
  subagents: readonly CompiledSubagentNode[],
): CompiledExternalDependencyRequest[] {
  const requests: CompiledExternalDependencyRequest[] = [];
  const nodes = [
    {
      dependencyScope: {
        kind: "application" as const,
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourceRoot: root.appRoot,
      },
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      resources: root,
    },
    ...subagents.map((subagent) => ({
      dependencyScope: createCompiledSubagentExternalDependencyScope(subagent),
      nodeId: subagent.nodeId,
      resources: subagent.agent,
    })),
  ];
  for (const { dependencyScope, nodeId, resources } of nodes) {
    const configDependencies =
      "config" in resources
        ? (resources.config.build?.externalDependencies ?? [])
        : (subagents.find((subagent) => subagent.nodeId === nodeId)?.configResolver?.build
            ?.externalDependencies ?? []);
    for (const packageName of externalDependencyPlanPackageNames(configDependencies)) {
      requests.push({ packageName, scope: dependencyScope });
    }
    for (const mount of resources.extensionMounts) {
      for (const packageName of externalDependencyPlanPackageNames(mount.externalDependencies)) {
        requests.push({
          packageName,
          scope: {
            kind: "extension",
            namespace: mount.namespace,
            nodeId,
            packageName: mount.packageName,
            sourceRoot: mount.sourceRoot,
          },
        });
      }
    }
  }
  return requests;
}

/** Projects one validated local subagent owner into its dependency-plan scope. */
export function createCompiledSubagentExternalDependencyScope(
  subagent: CompiledSubagentNode,
): CompiledExternalDependencyScope {
  if (subagent.owner.kind !== "extension") {
    return {
      kind: "application",
      nodeId: subagent.nodeId,
      sourceRoot: subagent.agent.appRoot,
    };
  }

  assertCompiledSourceBackingSemantics({
    backing: subagent.backing,
    nodeId: subagent.nodeId,
    owner: subagent.owner,
    sourceId: subagent.sourceId,
  });
  if (subagent.backing.kind !== "filesystem") {
    throw new Error(
      `Compiled node "${subagent.nodeId}" has extension-owned programmatic backing for "${subagent.sourceId}".`,
    );
  }
  return {
    kind: "extension",
    namespace: subagent.owner.namespace,
    nodeId: subagent.nodeId,
    packageName: subagent.owner.packageName,
    sourceRoot: subagent.backing.extensionScope!.sourceRoot,
  };
}

/** Stamps the selected config backing with the dependencies known after evaluation. */
export function withSelectedConfigExternalDependencies(
  graph: EffectiveAgentNodeSourceGraph,
  sourceId: string,
  externalDependencies: readonly string[],
): EffectiveAgentNodeSourceGraph {
  const binding = graph.bindings[sourceId];
  if (binding === undefined) {
    throw new Error(`Selected config source "${sourceId}" is missing its binding.`);
  }
  if (binding.backing.kind !== "filesystem") return graph;
  const nextBinding = {
    ...binding,
    backing: { ...binding.backing, externalDependencies: [...externalDependencies] },
  };
  const replacements = new Map<EffectiveAgentSourceCandidate, EffectiveAgentSourceCandidate>();
  for (const entry of graph.entries) {
    for (const candidate of entry.candidates) {
      if (candidate.descriptor.sourceId !== sourceId) continue;
      if (candidate.descriptor.sourceKind !== "module") {
        throw new Error(`Selected config source "${sourceId}" is not module-backed.`);
      }
      replacements.set(candidate, {
        ...candidate,
        descriptor: { ...candidate.descriptor, backing: nextBinding.backing },
      });
    }
  }
  return {
    ...graph,
    bindings: Object.freeze({ ...graph.bindings, [sourceId]: nextBinding }),
    entries: Object.freeze(
      graph.entries.map((entry) => ({
        ...entry,
        candidates: Object.freeze(
          entry.candidates.map((candidate) => replacements.get(candidate) ?? candidate),
        ),
        winner: replacements.get(entry.winner) ?? entry.winner,
      })),
    ),
    winners: Object.freeze(graph.winners.map((winner) => replacements.get(winner) ?? winner)),
  };
}

export function mergeExternalDependencies(
  ...dependencyLists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  return [...new Set(dependencyLists.flatMap((dependencies) => dependencies ?? []))];
}
