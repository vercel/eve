import type { CompiledAgentNodeManifest, CompiledInstructions } from "#compiler/manifest.js";
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
  ResolvedInstructions,
} from "#runtime/types.js";

/**
 * Input for resolving one compiled authored agent into a runtime-owned model.
 */
export interface ResolveAgentInput {
  manifest: CompiledAgentNodeManifest;
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
  // Disabled channel entries (kind === "disabled") are filtered out here
  // and surfaced separately on `ResolvedAgent.disabledFrameworkChannels`
  // so the graph resolver can remove the corresponding framework defaults.
  const resolvedChannels: ResolvedChannelDefinition[] = [];
  const disabledFrameworkChannels: string[] = [];

  for (const channelEntry of input.manifest.channels) {
    if (channelEntry.kind === "disabled") {
      disabledFrameworkChannels.push(channelEntry.name);
      continue;
    }
    resolvedChannels.push(
      await resolveChannelDefinition(channelEntry, input.moduleMap, input.nodeId),
    );
  }
  const resolvedTools = await Promise.all(
    input.manifest.tools.map((toolDefinition) =>
      resolveToolDefinition(toolDefinition, input.moduleMap, input.nodeId),
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
  const authoredSandbox =
    input.manifest.sandbox === null
      ? null
      : await resolveSandboxDefinition(input.manifest.sandbox, input.moduleMap, input.nodeId);
  const instructions = createResolvedInstructions(input.manifest.instructions);
  const workspaceResourceRoot = input.manifest.workspaceResourceRoot;
  const resolvedAgent: ResolvedAgent = {
    channels: resolvedChannels,
    config: createResolvedAgentConfig(input.manifest),
    connections: resolvedConnections,
    disabledFrameworkChannels,
    disabledFrameworkTools: [...input.manifest.disabledFrameworkTools],
    workflowEnabled: input.manifest.workflowEnabled,
    dynamicInstructionsResolvers: resolvedDynamicInstructionsResolvers,
    dynamicSkillResolvers: resolvedDynamicSkillResolvers,
    dynamicToolResolvers: resolvedDynamicToolResolvers,
    hooks: resolvedHooks,
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

  if (instructions !== undefined) {
    return { ...resolvedAgent, instructions };
  }

  return resolvedAgent;
}

function createResolvedInstructions(
  instructions: CompiledInstructions | undefined,
): ResolvedInstructions | undefined {
  if (instructions === undefined) {
    return undefined;
  }

  return {
    name: instructions.name,
    logicalPath: instructions.logicalPath,
    markdown: instructions.markdown,
    sourceId: instructions.sourceId,
    sourceKind: instructions.sourceKind,
  };
}

function createResolvedAgentConfig(manifest: CompiledAgentNodeManifest): ResolvedAgent["config"] {
  const config: {
    compaction?: ResolvedAgent["config"]["compaction"];
    experimental?: ResolvedAgent["config"]["experimental"];
    model: ResolvedAgent["config"]["model"];
    name: string;
    outputSchema?: ResolvedAgent["config"]["outputSchema"];
    reasoning?: ResolvedAgent["config"]["reasoning"];
    source?: ResolvedAgent["config"]["source"];
    limits?: ResolvedAgent["config"]["limits"];
  } = {
    model:
      manifest.config.model.source === undefined
        ? {
            id: manifest.config.model.id,
            contextWindowTokens: manifest.config.model.contextWindowTokens,
            providerOptions: manifest.config.model.providerOptions,
          }
        : {
            contextWindowTokens: manifest.config.model.contextWindowTokens,
            id: manifest.config.model.id,
            providerOptions: manifest.config.model.providerOptions,
            source: {
              exportName: manifest.config.model.source.exportName,
              sourceKind: "module" as const,
              logicalPath: manifest.config.model.source.logicalPath,
              sourceId: manifest.config.model.source.sourceId,
            },
          },
    name: manifest.config.name,
  };

  if (manifest.config.compaction !== undefined) {
    const compaction: {
      model?: ResolvedAgent["config"]["model"];
      thresholdPercent?: number;
    } = {};

    if (manifest.config.compaction.model !== undefined) {
      compaction.model =
        manifest.config.compaction.model.source === undefined
          ? {
              contextWindowTokens: manifest.config.compaction.model.contextWindowTokens,
              id: manifest.config.compaction.model.id,
              providerOptions: manifest.config.compaction.model.providerOptions,
            }
          : {
              contextWindowTokens: manifest.config.compaction.model.contextWindowTokens,
              id: manifest.config.compaction.model.id,
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
      maxSubagentDepth: manifest.config.limits.maxSubagentDepth,
    };
  }

  return config;
}
