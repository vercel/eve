import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledInstructionsDefinition,
} from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/module-binding.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveChannelDefinition } from "#runtime/resolve-channel.js";

import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import { resolveHookDefinition } from "#runtime/resolve-hook.js";
import { createResolvedModuleSourceRef, ResolveAgentError } from "#runtime/resolve-helpers.js";
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
    metadata:
      skill.metadata === undefined
        ? undefined
        : {
            ...skill.metadata,
          },
  })) satisfies ResolvedSkillDefinition[];
  const resolvedChannels: ResolvedChannelDefinition[] = [];

  for (const channelEntry of input.manifest.channelRoutes.effective) {
    resolvedChannels.push(
      await resolveChannelDefinition(channelEntry, input.moduleMap, input.nodeId),
    );
  }
  const resolvedTools = await Promise.all(
    input.manifest.tools.map((toolDefinition) =>
      resolveToolDefinition(
        toolDefinition,
        input.moduleMap,
        input.nodeId,
        resolveModuleOwner(toolDefinition, input.manifest, "tool"),
      ),
    ),
  );
  const resolvedDynamicInstructionsResolvers = await Promise.all(
    input.manifest.dynamicInstructions.map((def) =>
      resolveDynamicInstructionsDefinition(def, input.moduleMap, input.nodeId),
    ),
  );
  const resolvedDynamicSkillResolvers = await Promise.all(
    input.manifest.dynamicSkills.map((def) =>
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
  const sandbox = await resolveSandboxDefinition(
    input.manifest.sandbox,
    input.moduleMap,
    input.nodeId,
  );
  const instructions = input.manifest.instructions.map((definition) =>
    createResolvedInstructionsDefinition(definition, input.manifest),
  );
  const workspaceResourceRoot = input.manifest.workspaceResourceRoot;
  const resolvedAgent: ResolvedAgent = {
    channels: resolvedChannels,
    connections: resolvedConnections,
    kernelPlan: { prepared: [...input.manifest.kernelPlan.prepared] },
    workflowTool:
      input.manifest.workflowTool === undefined
        ? undefined
        : { maxSubagents: input.manifest.workflowTool.maxSubagents },
    webSearchProvider: input.manifest.webSearchProvider?.provider,
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
    sandbox,
    workspaceResourceRoot,
    skills: resolvedSkills,
    tools: resolvedTools,
    workspaceSpec: { rootEntries: [...workspaceResourceRoot.rootEntries] },
  };

  return "config" in input.manifest
    ? { ...resolvedAgent, config: createResolvedAgentConfig(input.manifest) }
    : resolvedAgent;
}

function createResolvedInstructionsDefinition(
  instructions: CompiledInstructionsDefinition,
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ResolvedInstructionsDefinition {
  const base = {
    content: instructions.content,
    name: instructions.name,
    logicalPath: instructions.logicalPath,
    owner: resolveInstructionsOwner(instructions, manifest),
    role: instructions.role,
    sourceId: instructions.sourceId,
  };
  return instructions.sourceKind === "module"
    ? { ...base, exportName: instructions.exportName, sourceKind: "module" }
    : { ...base, sourceKind: "markdown" };
}

function resolveInstructionsOwner(
  instructions: CompiledInstructionsDefinition,
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): AgentSourceOwner {
  if (instructions.sourceKind === "module") {
    return resolveModuleOwner(instructions, manifest, "instructions");
  }

  const selected = manifest.sourceComposition.selected.find(
    (entry) => entry.sourceKind === "non-module" && entry.source.sourceId === instructions.sourceId,
  );
  if (
    selected === undefined ||
    selected.sourceKind !== "non-module" ||
    selected.source.sourceKind !== instructions.sourceKind ||
    selected.source.logicalPath !== instructions.logicalPath
  ) {
    throw new ResolveAgentError(
      `Cannot resolve instructions source "${instructions.logicalPath}" because its selected source descriptor "${instructions.sourceId}" is missing or inconsistent.`,
      { logicalPath: instructions.logicalPath, sourceId: instructions.sourceId },
    );
  }
  return { ...selected.source.owner };
}

function resolveModuleOwner(
  source: { readonly logicalPath: string; readonly sourceId: string },
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  kindLabel: string,
): AgentSourceOwner {
  const binding = manifest.bindings[source.sourceId];
  if (binding === undefined) {
    throw new ResolveAgentError(
      `Cannot resolve ${kindLabel} source "${source.logicalPath}" because compiled binding "${source.sourceId}" is missing.`,
      { logicalPath: source.logicalPath, sourceId: source.sourceId },
    );
  }
  return { ...binding.owner };
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
    source: NonNullable<ResolvedAgent["config"]>["source"];
    limits?: NonNullable<ResolvedAgent["config"]>["limits"];
  } = {
    name: manifest.config.name,
    source: createResolvedModuleSourceRef(manifest.config.source),
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
    };
  }

  if (manifest.config.outputSchema !== undefined) {
    config.outputSchema = manifest.config.outputSchema;
  }

  if (manifest.config.reasoning !== undefined) {
    config.reasoning = manifest.config.reasoning;
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
