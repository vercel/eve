import { resolve } from "node:path";

import type { AgentModuleCandidate } from "#compiler/agent-module-candidate.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { composeAgentModuleCandidates } from "#compiler/compose-agent-module-candidates.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import { createProgrammaticModuleCandidates } from "#compiler/programmatic-module-candidates.js";
import type { AgentSourceManifest, ChannelSourceRef, ToolSourceRef } from "#discover/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export interface ComposedFrameworkSources {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly manifest: AgentSourceManifest;
}

export function composeFrameworkSources(input: {
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly registry: AgentSourceRegistry;
}): ComposedFrameworkSources {
  const applicationRefs = [
    ...input.manifest.channels,
    ...input.manifest.tools,
    ...(input.manifest.sandbox === null ? [] : [input.manifest.sandbox]),
  ];
  const applicationCandidates = applicationRefs.map((source) =>
    createApplicationCandidate(input.manifest, input.nodeId, source),
  );
  const frameworkCandidates = createProgrammaticModuleCandidates({
    isRoot: input.isRoot,
    nodeId: input.nodeId,
    registry: input.registry,
  }).filter(
    (candidate) =>
      candidate.logicalPath.startsWith("channels/") ||
      candidate.logicalPath === "sandbox.ts" ||
      candidate.logicalPath.startsWith("tools/"),
  );
  const composition = composeAgentModuleCandidates([
    ...frameworkCandidates,
    ...applicationCandidates,
  ]);
  const refsBySourceId = new Map(applicationRefs.map((source) => [source.sourceId, source]));
  const bindings: Record<string, CompiledModuleBinding> = {};
  const channels: ChannelSourceRef[] = [];
  const tools: ToolSourceRef[] = [];
  let sandbox: ModuleSourceRef | null = null;

  for (const winner of composition.winners) {
    const source =
      refsBySourceId.get(winner.sourceId) ?? createProgrammaticSourceRef(input.registry, winner);
    if (winner.backing.kind === "programmatic") {
      bindings[winner.sourceId] = {
        backing: winner.backing,
        logicalPath: winner.logicalPath,
        owner: winner.owner,
      };
    }
    if (winner.logicalPath.startsWith("channels/")) channels.push(source);
    if (winner.logicalPath.startsWith("tools/")) tools.push(source);
    if (winner.logicalPath === "sandbox.ts" || winner.logicalPath.startsWith("sandbox/")) {
      sandbox = source;
    }
  }

  return {
    bindings,
    manifest: { ...input.manifest, channels, sandbox, tools },
  };
}

function createApplicationCandidate(
  manifest: AgentSourceManifest,
  nodeId: string,
  source: ModuleSourceRef,
): AgentModuleCandidate {
  return {
    backing: {
      externalDependencies: [],
      kind: "filesystem",
      sourcePath: resolve(manifest.agentRoot, source.logicalPath),
    },
    layer: "application",
    logicalPath: source.logicalPath,
    nodeId,
    owner: { kind: "application" },
    sourceId: source.sourceId,
  };
}

function createProgrammaticSourceRef(
  registry: AgentSourceRegistry,
  candidate: AgentModuleCandidate,
): ModuleSourceRef {
  if (candidate.backing.kind !== "programmatic") {
    throw new Error(`Expected "${candidate.sourceId}" to have a programmatic backing.`);
  }
  const module = registry.getModule(candidate.backing);
  return {
    exportName: module.exportName,
    logicalPath: candidate.logicalPath,
    sourceId: candidate.sourceId,
    sourceKind: "module",
  };
}
