import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledInstructionsDefinition,
} from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveChannelDefinition } from "#runtime/resolve-channel.js";

// Re-exported so external consumers (tests, integrations) can keep
// importing the error class from this path even though it now lives
// in resolve-helpers.ts.
export { ResolveAgentError } from "#runtime/resolve-helpers.js";

import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import { resolveHookDefinition } from "#runtime/resolve-hook.js";
import { createResolvedModuleSourceRef } from "#runtime/resolve-helpers.js";
import { resolveSandboxDefinition } from "#runtime/resolve-sandbox.js";
import { resolveDynamicInstructionsDefinition } from "#runtime/resolve-dynamic-instructions.js";
import { resolveDynamicSkillDefinition } from "#runtime/resolve-dynamic-skill.js";
import { resolveDynamicToolDefinition } from "#runtime/resolve-dynamic-tool.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";
import type {
  ResolvedAgent,
  ResolvedChannelDefinition,
  ResolvedSkillDefinition,
  ResolvedInstructionsDefinition,
} from "#runtime/types.js";

/**
 * Input for resolving one compiled authored agent into a runtime-owned model.
 */
export interface ResolveAgentInput {
  manifest: CompiledAgentNodeManifest | CompiledAgentResources;
  moduleMap: CompiledModuleMap;
  nodeId?: string;
}

/**
 * Resolves the core authored agent path from compiled artifacts.
 */
export async function resolveAgent(input: ResolveAgentInput): Promise<ResolvedAgent> {
  const resolvedSkills = input.manifest.skills.map((skill) => ({
    ...skill,
    owner: requireCompiledSourceOwner(input.manifest, skill),
    metadata:
      skill.metadata === undefined
        ? undefined
        : {
            ...skill.metadata,
          },
  })) satisfies ResolvedSkillDefinition[];
  const resolvedChannels: ResolvedChannelDefinition[] = await Promise.all(
    input.manifest.channelRoutes.effective.map((channelEntry) =>
      resolveChannelDefinition(channelEntry, input.moduleMap, input.nodeId),
    ),
  );
  const resolvedTools = await Promise.all(
    input.manifest.tools.map((toolDefinition) =>
      resolveToolDefinition(
        toolDefinition,
        input.moduleMap,
        input.nodeId,
        requireBindingOwner(input.manifest, toolDefinition.sourceId),
      ),
    ),
  );
  const resolvedDynamicInstructionsResolvers = await Promise.all(
    (input.manifest.dynamicInstructions ?? []).map((def) =>
      resolveDynamicInstructionsDefinition(def, input.moduleMap, input.nodeId),
    ),
  );
  const resolvedDynamicSkillResolvers = await Promise.all(
    (input.manifest.dynamicSkills ?? []).map((def) =>
      resolveDynamicSkillDefinition(def, input.moduleMap, input.nodeId),
    ),
  );
  const resolvedDynamicToolResolvers = await Promise.all(
    input.manifest.dynamicTools.map((def) =>
      resolveDynamicToolDefinition(def, input.moduleMap, input.nodeId),
    ),
  );
  // Hook resolution preserves the manifest's lexicographic-on-slug order
  // produced by the discovery walker; the per-node registry inherits
  // that order.
  const resolvedHooks = await Promise.all(
    input.manifest.hooks.map((hookDefinition) =>
      resolveHookDefinition(hookDefinition, input.moduleMap, input.nodeId),
    ),
  );
  const resolvedConnections = await Promise.all(
    input.manifest.connections.map((connectionDefinition) =>
      resolveConnectionDefinition(connectionDefinition, input.moduleMap, input.nodeId),
    ),
  );
  const authoredSandbox = await resolveSandboxDefinition(
    input.manifest.sandbox,
    input.moduleMap,
    input.nodeId,
  );
  const instructions = input.manifest.instructions.map((definition) =>
    createResolvedInstructionsDefinition(input.manifest, definition),
  );
  const workspaceResourceRoot = input.manifest.workspaceResourceRoot;
  const resolvedAgent: ResolvedAgent = {
    channels: resolvedChannels,
    connections: resolvedConnections,
    workflowTool:
      input.manifest.workflowTool === undefined
        ? undefined
        : { maxSubagents: input.manifest.workflowTool.maxSubagents },
    webSearchProvider: input.manifest.webSearchProvider,
    dynamicInstructionsResolvers: resolvedDynamicInstructionsResolvers,
    dynamicSkillResolvers: resolvedDynamicSkillResolvers,
    dynamicToolResolvers: resolvedDynamicToolResolvers,
    hooks: resolvedHooks,
    instructions,
    metadata: {
      agentRoot: input.manifest.agentRoot,
      appRoot: input.manifest.appRoot,
      diagnosticsSummary: input.manifest.diagnosticsSummary,
    },
    sandbox: authoredSandbox,
    workspaceResourceRoot,
    skills: resolvedSkills,
    tools: resolvedTools,
    workspaceSpec: { rootEntries: [...workspaceResourceRoot.rootEntries] },
  };

  return "config" in input.manifest
    ? { ...resolvedAgent, config: createResolvedAgentConfig(input.manifest) }
    : resolvedAgent;
}

function requireBindingOwner(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  sourceId: string,
) {
  const binding = manifest.bindings[sourceId];
  if (binding === undefined) throw new Error(`Compiled source "${sourceId}" has no binding.`);
  return binding.owner;
}

function createResolvedInstructionsDefinition(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  instructions: CompiledInstructionsDefinition,
): ResolvedInstructionsDefinition {
  return {
    content: instructions.content,
    name: instructions.name,
    owner: requireCompiledSourceOwner(manifest, instructions),
    logicalPath: instructions.logicalPath,
    role: instructions.role,
    sourceId: instructions.sourceId,
    sourceKind: instructions.sourceKind,
  };
}

function requireCompiledSourceOwner(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  source: {
    readonly owner?: AgentSourceOwner;
    readonly sourceId: string;
  },
): AgentSourceOwner {
  const owner = manifest.bindings[source.sourceId]?.owner ?? source.owner;
  if (owner === undefined) {
    throw new Error(`Compiled source "${source.sourceId}" has no owner.`);
  }
  return owner;
}

function createResolvedAgentConfig(
  manifest: CompiledAgentNodeManifest,
): NonNullable<ResolvedAgent["config"]> {
  const config: {
    compaction?: NonNullable<ResolvedAgent["config"]>["compaction"];
    experimental?: NonNullable<ResolvedAgent["config"]>["experimental"];
    name: string;
    outputSchema?: NonNullable<ResolvedAgent["config"]>["outputSchema"];
    reasoning?: NonNullable<ResolvedAgent["config"]>["reasoning"];
    source?: NonNullable<ResolvedAgent["config"]>["source"];
    limits?: NonNullable<ResolvedAgent["config"]>["limits"];
  } = {
    name: manifest.config.name,
  };

  if (manifest.config.compaction !== undefined) {
    const compaction: {
      model?: NonNullable<NonNullable<ResolvedAgent["config"]>["compaction"]>["model"];
      thresholdPercent?: number;
    } = {};

    if (manifest.config.compaction.model !== undefined) {
      compaction.model =
        manifest.config.compaction.model.source === undefined
          ? {
              contextWindowTokens: manifest.config.compaction.model.contextWindowTokens,
              id: manifest.config.compaction.model.id,
              maxOutputTokens: manifest.config.compaction.model.maxOutputTokens,
              providerOptions: manifest.config.compaction.model.providerOptions,
            }
          : {
              contextWindowTokens: manifest.config.compaction.model.contextWindowTokens,
              id: manifest.config.compaction.model.id,
              maxOutputTokens: manifest.config.compaction.model.maxOutputTokens,
              providerOptions: manifest.config.compaction.model.providerOptions,
              source: {
                exportName: manifest.config.compaction.model.source.exportName,
                sourceKind: "module" as const,
                logicalPath: manifest.config.compaction.model.source.logicalPath,
                sourceId: manifest.config.compaction.model.source.sourceId,
              },
            };
    }

    if (manifest.config.compaction.thresholdPercent !== undefined) {
      compaction.thresholdPercent = manifest.config.compaction.thresholdPercent;
    }

    config.compaction = compaction;
  }

  if (manifest.config.experimental !== undefined) {
    config.experimental = {
      instrumentationProviders: manifest.config.experimental.instrumentationProviders,
      subagentPersistentSessions: manifest.config.experimental.subagentPersistentSessions,
      tasks: manifest.config.experimental.tasks,
      workflow:
        manifest.config.experimental.workflow === undefined
          ? undefined
          : { world: manifest.config.experimental.workflow.world },
    };
  }

  if (manifest.config.outputSchema !== undefined) {
    config.outputSchema = manifest.config.outputSchema;
  }

  if (manifest.config.reasoning !== undefined) {
    config.reasoning = manifest.config.reasoning;
  }

  if (manifest.config.source !== undefined) {
    config.source = createResolvedModuleSourceRef(manifest.config.source);
  }

  if (manifest.config.limits !== undefined) {
    config.limits = {
      maxInputTokensPerSession: manifest.config.limits.maxInputTokensPerSession,
      maxOutputTokensPerSession: manifest.config.limits.maxOutputTokensPerSession,
      sessionTimeoutMs: manifest.config.limits.sessionTimeoutMs,
    };
  }

  if (manifest.config.dynamicModel !== undefined) {
    return {
      ...config,
      dynamicModel: {
        ...createResolvedModuleSourceRef(manifest.config.dynamicModel),
        eventNames: [...manifest.config.dynamicModel.eventNames],
      },
    };
  }

  const model = manifest.config.model;
  return {
    ...config,
    model:
      model.source === undefined
        ? {
            id: model.id,
            contextWindowTokens: model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
            providerOptions: model.providerOptions,
          }
        : {
            contextWindowTokens: model.contextWindowTokens,
            id: model.id,
            maxOutputTokens: model.maxOutputTokens,
            providerOptions: model.providerOptions,
            source: {
              exportName: model.source.exportName,
              sourceKind: "module" as const,
              logicalPath: model.source.logicalPath,
              sourceId: model.source.sourceId,
            },
          },
  };
}
