import { join } from "node:path";

import type { CompiledAgentManifest, CompiledAgentNodeManifest } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { collectModuleRefsForManifest, type CompiledModuleMap } from "#compiler/module-map.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";

/**
 * Loads a disk-backed module map by hydrating authored modules directly from
 * source. This is for dev/build flows that need tsconfig alias support and
 * source reloads without relying on Node's module cache for module-map.mjs.
 */
export async function loadCompiledModuleMapFromAuthoredSource(input: {
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
}): Promise<CompiledModuleMap> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });

  return await hydrateCompiledModuleMapFromManifest(manifest);
}

async function hydrateCompiledModuleMapFromManifest(
  manifest: CompiledAgentManifest,
): Promise<CompiledModuleMap> {
  const nodes: CompiledModuleMap["nodes"] = {};
  const nodeManifests: Array<{
    agentRoot: string;
    manifest: CompiledAgentNodeManifest;
    nodeId: string;
  }> = [
    {
      agentRoot: manifest.agentRoot,
      manifest,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({
        agentRoot: subagent.agent.agentRoot,
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      })),
  ];

  for (const nodeManifest of nodeManifests) {
    nodes[nodeManifest.nodeId] = {
      modules: await hydrateCompiledNodeScope({
        agentRoot: nodeManifest.agentRoot,
        manifest: nodeManifest.manifest,
      }),
    };
  }

  return {
    nodes,
  };
}

async function hydrateCompiledNodeScope(input: {
  agentRoot: string;
  manifest: CompiledAgentNodeManifest;
}): Promise<CompiledModuleMap["nodes"][string]["modules"]> {
  const refs = collectModuleRefsForManifest(input.manifest).sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];
  const modules: CompiledModuleMap["nodes"][string]["modules"] = {};

  for (const ref of refs) {
    const modulePath = join(input.agentRoot, ref.logicalPath);

    modules[ref.sourceId] = await loadAuthoredModuleNamespace(modulePath, {
      externalDependencies,
    });
  }

  return modules;
}
