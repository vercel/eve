import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import { type CompiledModuleBinding } from "#compiler/module-binding.js";
import {
  collectModuleRefsForManifest,
  collectUniqueModuleRefsForManifest,
} from "#compiler/module-references.js";
import type { CompiledRemoteAgentNode } from "#compiler/remote-agent-node.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export interface CompiledModuleScope {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly nodeId: string;
  readonly refs: readonly ModuleSourceRef[];
}

/** Returns every independently-owned module scope in deterministic graph order. */
export function collectCompiledModuleScopes(
  manifest: CompiledAgentManifest,
): readonly CompiledModuleScope[] {
  const resourceScopes: readonly {
    readonly additionalRef?: ModuleSourceRef;
    readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
    readonly nodeId: string;
  }[] = [
    { manifest, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({
        additionalRef: subagent.configResolver,
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      })),
  ];
  const scopes: CompiledModuleScope[] = resourceScopes.map((scope) => {
    const additionalRefs = scope.additionalRef === undefined ? [] : [scope.additionalRef];
    return {
      bindings: scope.manifest.bindings,
      nodeId: scope.nodeId,
      refs: [...collectUniqueModuleRefsForManifest(scope.manifest), ...additionalRefs],
    };
  });
  const nodeIds = new Set<string>();
  for (const scope of scopes) assertUniqueModuleScopeNodeId(nodeIds, scope.nodeId);

  const remoteAgents = resourceScopes
    .flatMap((scope) => scope.manifest.remoteAgents)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  for (const remoteAgent of remoteAgents) {
    assertUniqueModuleScopeNodeId(nodeIds, remoteAgent.nodeId);
    scopes.push(toRemoteModuleScope(remoteAgent));
  }
  return scopes;
}

function assertUniqueModuleScopeNodeId(nodeIds: Set<string>, nodeId: string): void {
  if (nodeIds.has(nodeId)) {
    throw new Error(`Compiled module scope node id "${nodeId}" is present more than once.`);
  }
  nodeIds.add(nodeId);
}

function toRemoteModuleScope(remoteAgent: CompiledRemoteAgentNode): CompiledModuleScope {
  return {
    bindings: remoteAgent.bindings,
    nodeId: remoteAgent.nodeId,
    refs: [remoteAgent.configResolver],
  };
}

export { collectModuleRefsForManifest };
