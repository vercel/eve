import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  collectModuleRefsForManifest,
  requireModuleBinding,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import {
  loadProgrammaticModuleNamespace,
  type AgentSourceRegistry,
} from "#compiler/source-graph.js";

/**
 * Builds a compiled module map by awaiting the selected programmatic
 * loaders referenced by one compiled manifest. Exposes the same
 * `(nodeId, sourceId)` set as the generated, materialized, bundled, and
 * hydrated maps, and invokes only selected loaders — no virtual disk path
 * is ever probed.
 *
 * Used by the in-memory compiler, whose sources are all programmatic. A
 * filesystem binding is a caller error here; disk-backed manifests hydrate
 * through the authored module-map loader instead.
 */
export async function createProgrammaticCompiledModuleMap(input: {
  readonly manifest: CompiledAgentManifest;
  readonly registry: AgentSourceRegistry;
}): Promise<CompiledModuleMap> {
  const nodes: CompiledModuleMap["nodes"] = {};
  const scopes = [
    { manifest: input.manifest, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
    ...input.manifest.subagents.map((subagent) => ({
      additionalModuleRef: subagent.configResolver,
      manifest: subagent.agent,
      nodeId: subagent.nodeId,
    })),
  ];

  for (const scope of scopes) {
    const modules: Record<string, Record<string, unknown>> = {};
    const refs = [
      ...collectModuleRefsForManifest(scope.manifest),
      ...("additionalModuleRef" in scope && scope.additionalModuleRef !== undefined
        ? [scope.additionalModuleRef]
        : []),
    ];
    for (const ref of refs) {
      const binding = requireModuleBinding(scope.manifest.bindings, ref, scope.nodeId);
      if (binding.backing.kind !== "programmatic") {
        throw new Error(
          `createProgrammaticCompiledModuleMap resolves only programmatic bindings; ` +
            `source "${ref.sourceId}" in node "${scope.nodeId}" is filesystem-backed.`,
        );
      }
      modules[ref.sourceId] = {
        ...(await loadProgrammaticModuleNamespace(input.registry, binding.backing)),
      };
    }
    nodes[scope.nodeId] = { modules };
  }

  return { nodes };
}
