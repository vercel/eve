import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledInstructionsDefinition,
} from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { CompiledModuleMap } from "#compiler/module-map-schema.js";
import { resolveChannelDefinition } from "#runtime/resolve-channel.js";

import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import { resolveDefinition, resolveScheduleCollection } from "#runtime/resolve-definition.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { createResolvedModuleSourceRef } from "#runtime/resolve-helpers.js";
import { resolveSandboxDefinition } from "#runtime/resolve-sandbox.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type {
  ResolvedAgent,
  ResolvedChannelDefinition,
  ResolvedSkillDefinition,
  ResolvedInstructionsDefinition,
} from "#runtime/types.js";
import type { AgentToolExposure, SessionUsageLimit } from "#shared/agent-definition.js";
import type { ApprovalPolicy } from "#approval/definition.js";

/**
 * Input for resolving one compiled authored agent into a runtime-owned model.
 */
interface ResolveAgentInput {
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
  const scope = {
    moduleMap: input.moduleMap,
    nodeId: input.nodeId,
    toolFiles: toolFileNames(input.manifest),
  };
  const definitions = await Promise.all([
    ...input.manifest.definitions.map((definition) => resolveDefinition(definition, scope)),
    ...input.manifest.scheduleCollections.map((collection) =>
      resolveScheduleCollection(collection, scope),
    ),
  ]);
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
    definitions,
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
    ? {
        ...resolvedAgent,
        config: createResolvedAgentConfig(
          input.manifest,
          await loadAgentConfigFunctions(input.manifest, input.moduleMap, input.nodeId),
        ),
      }
    : resolvedAgent;
}

interface AgentConfigFunctions {
  readonly approval?: ApprovalPolicy;
  readonly sessionUsage?: SessionUsageLimit | false;
}

/** Loads the authored functions the manifest can only mark: `limits.sessionUsage` and `approval`. */
async function loadAgentConfigFunctions(
  manifest: CompiledAgentNodeManifest,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<AgentConfigFunctions> {
  const sessionUsage = manifest.config.limits?.sessionUsage;
  const approval = manifest.config.approval === true;
  const source = manifest.config.source;
  if (approval && source === undefined) {
    throw new Error(
      'The compiled agent marks an "approval" policy but has no agent config module.',
    );
  }
  if ((sessionUsage !== true && !approval) || source === undefined) {
    return sessionUsage === false ? { sessionUsage: false } : {};
  }
  const definition = await loadResolvedModuleExport({
    definition: source,
    kindLabel: "agent config",
    moduleMap,
    nodeId,
  });
  const authored = normalizeAgentDefinition(
    definition,
    `Expected the authored agent config export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  // A gate the manifest promises but the module no longer has would fail open; refuse to start.
  if (approval && authored.approval === undefined) {
    throw new Error(
      `The compiled agent marks an "approval" policy, but "${source.logicalPath}" no longer exports one. Rebuild the agent.`,
    );
  }
  return {
    ...(approval && { approval: authored.approval }),
    sessionUsage: sessionUsage === false ? false : authored.limits?.sessionUsage,
  };
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
  { approval, sessionUsage }: AgentConfigFunctions,
): NonNullable<ResolvedAgent["config"]> {
  const config: {
    approval?: ApprovalPolicy;
    compaction?: NonNullable<ResolvedAgent["config"]>["compaction"];
    defaultTools?: boolean;
    description?: string;
    experimental?: NonNullable<ResolvedAgent["config"]>["experimental"];
    name: string;
    reasoning?: NonNullable<ResolvedAgent["config"]>["reasoning"];
    source?: NonNullable<ResolvedAgent["config"]>["source"];
    tool?: AgentToolExposure;
    limits?: NonNullable<ResolvedAgent["config"]>["limits"];
  } = {
    name: manifest.config.name,
  };

  if (manifest.config.defaultTools !== undefined) {
    config.defaultTools = manifest.config.defaultTools;
  }
  if (approval !== undefined) {
    config.approval = approval;
  }
  if (manifest.config.description !== undefined) {
    config.description = manifest.config.description;
  }

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
              sourceField: manifest.config.compaction.model.sourceField,
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
          : {
              modelCallsPerStep: manifest.config.experimental.workflow.modelCallsPerStep,
              retention: manifest.config.experimental.workflow.retention,
              world: manifest.config.experimental.workflow.world,
            },
    };
  }

  if (manifest.config.reasoning !== undefined) {
    config.reasoning = manifest.config.reasoning;
  }

  if (manifest.config.source !== undefined) {
    config.source = createResolvedModuleSourceRef(manifest.config.source);
  }

  if (manifest.config.tool !== undefined) {
    config.tool = manifest.config.tool;
  }

  if (manifest.config.limits !== undefined) {
    config.limits = { sessionTimeoutMs: manifest.config.limits.sessionTimeoutMs, sessionUsage };
  }

  if (manifest.config.dynamicModel !== undefined) {
    return {
      ...config,
      dynamicModel: createResolvedModuleSourceRef(manifest.config.dynamicModel),
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
            providerOptions: model.providerOptions,
          }
        : {
            contextWindowTokens: model.contextWindowTokens,
            id: model.id,
            promptCache: model.promptCache,
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

/**
 * The names the agent's tool files take, selected or disabled: an eve feature that offers tools
 * under one of them, such as a memory slot's, yields to the file. eve's own built-in tools aren't
 * the agent's files, so a slot named like one still offers its tools beside it.
 */
function toolFileNames(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ReadonlySet<string> {
  return new Set([
    ...manifest.tools.flatMap(({ name, sourceId }) =>
      manifest.bindings[sourceId]?.owner.kind === "framework" ? [] : [name],
    ),
    ...manifest.definitions.flatMap((definition) =>
      definition.kind === "tool" && definition.extensionNamespace === undefined
        ? [definition.slug]
        : [],
    ),
    ...disabledToolNames(manifest),
  ]);
}

/** The names of the tool files that export `disableTool()`. */
export function disabledToolNames(
  manifest: Pick<CompiledAgentResources, "sourceComposition">,
): readonly string[] {
  return manifest.sourceComposition.entries.flatMap((entry) => {
    if (entry.kind !== "disabled" || !entry.source.logicalPath.startsWith("tools/")) return [];
    return [
      stripLogicalPathExtension(entry.source.logicalPath)
        .replace(/^tools\//, "")
        .replaceAll("/", "-"),
    ];
  });
}
