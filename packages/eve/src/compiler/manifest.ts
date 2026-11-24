import type { z } from "#compiled/zod/index.js";

import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type {
  CompiledDynamicSubagentDefinition,
  CompiledRemoteAgentNode,
} from "#compiler/remote-agent-node.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { InternalInstructionsDefinition } from "#shared/instructions-definition.js";
import type { JsonObject } from "#shared/json.js";
import type { Node } from "#shared/node.js";
import type {
  MarkdownSourceRef,
  ModuleSourceRef,
  SkillPackageSourceRef,
} from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import type {
  InternalAgentDefinition,
  InternalAgentModelDefinition,
  InternalAgentCompactionDefinition,
  AgentBuildDefinition,
  ModelRouting,
} from "#shared/agent-definition.js";
import type { VercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";
import type {
  AgentSourceComposition,
  AgentSourceDescriptor,
  AgentSourceOwner,
  CompiledModuleBinding,
} from "#compiler/source-graph.js";
import {
  validateCompiledAgentManifest,
  validateCompiledAgentResources,
} from "#compiler/validate-artifact.js";
import type {
  compiledScheduleDefinitionSchema,
  compiledScheduleCollectionDefinitionSchema,
  compiledSandboxDefinitionSchema,
  compiledSandboxWorkspaceSchema,
  compiledWorkspaceResourceRootSchema,
  compiledConnectionDefinitionSchema,
  compiledAgentResourcesSchema,
  compiledAgentNodeManifestSchema,
  compiledAgentManifestSchema,
} from "#compiler/manifest-schema.js";

export const COMPILED_AGENT_MANIFEST_KIND = "eve-agent-compiled-manifest";

export const ROOT_COMPILED_AGENT_NODE_ID = "__root__";

export const COMPILED_AGENT_MANIFEST_VERSION = 57;

export interface CompiledChannelDefinition {
  readonly kind: "channel";
  readonly name: string;
  readonly logicalPath: string;
  readonly method: ChannelRouteMethod;
  readonly urlPath: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
  readonly exportName?: string;
  readonly adapterKind?: string;
  readonly cors?: NormalizedChannelCorsOptions;
  readonly manifest?: JsonObject;
  readonly vercelConnect?: VercelConnectMetadata;
}

export interface CompiledChannelPreflightDefinition {
  readonly cors: NormalizedChannelCorsOptions;
  readonly method: "OPTIONS";
  readonly sourceIds: readonly string[];
  readonly urlPath: string;
}

export interface CompiledShadowedChannelRoute {
  readonly method: ChannelRouteMethod;
  readonly source: AgentSourceDescriptor;
  readonly urlPath: string;
  readonly winnerSourceId: string;
}

export interface CompiledChannelRoutePlan {
  readonly effective: readonly CompiledChannelDefinition[];
  readonly preflight: readonly CompiledChannelPreflightDefinition[];
  readonly shadowed: readonly CompiledShadowedChannelRoute[];
}

export type CompiledRuntimeModelReference = InternalAgentModelDefinition & {
  routing: ModelRouting;
};

export type CompiledDynamicModelDefinition = ModuleSourceRef;

export type CompiledAgentBuildDefinition = AgentBuildDefinition;

export type CompiledAgentCompactionDefinition = Omit<InternalAgentCompactionDefinition, "model"> & {
  model?: CompiledRuntimeModelReference;
};

type CompiledAgentDefinitionBase = Omit<InternalAgentDefinition, "model" | "compaction"> & {
  compaction?: CompiledAgentCompactionDefinition;
  source: ModuleSourceRef;
};

export type CompiledAgentDefinition = CompiledAgentDefinitionBase &
  (
    | {
        readonly model: CompiledRuntimeModelReference;
        readonly dynamicModel?: never;
      }
    | {
        readonly model?: never;
        readonly dynamicModel: CompiledDynamicModelDefinition;
      }
  );

export type CompiledInstructionsDefinition = InternalInstructionsDefinition &
  (
    | (Omit<MarkdownSourceRef<undefined>, "definition"> & {
        readonly owner: AgentSourceOwner;
      })
    | Omit<ModuleSourceRef, "exportName">
  );

export type CompiledSkillDefinition = NamedSkillDefinition &
  (
    | (Omit<MarkdownSourceRef<undefined>, "definition"> & {
        readonly owner: AgentSourceOwner;
      })
    | ModuleSourceRef
    | (SkillPackageSourceRef & { readonly owner: AgentSourceOwner })
  );

export type CompiledScheduleDefinition = z.infer<typeof compiledScheduleDefinitionSchema>;
export type CompiledScheduleCollectionDefinition = z.infer<
  typeof compiledScheduleCollectionDefinitionSchema
>;

export type CompiledSandboxDefinition = z.infer<typeof compiledSandboxDefinitionSchema>;

type CompiledSandboxWorkspace = z.infer<typeof compiledSandboxWorkspaceSchema>;

export type CompiledWorkspaceResourceRoot = z.infer<typeof compiledWorkspaceResourceRootSchema>;

export type CompiledConnectionDefinition = z.infer<typeof compiledConnectionDefinitionSchema>;

export type CompiledToolDefinition = InternalToolDefinition &
  ModuleSourceRef & {
    readonly behavior?: CompiledToolBehavior;
    readonly hasExecute: boolean;
    readonly hasModelOutputProjection: boolean;
    readonly modelInputSchema?: JsonObject;
    readonly requiresApproval: boolean;
    readonly workflowProgram?: {
      readonly maxSubagents: number;
      readonly tools?: true;
    };
  };

export type CompiledDefinitionKind =
  | "connection"
  | "hook"
  | "instructions"
  | "memory"
  | "skill"
  | "tool";

export interface CompiledDefinition extends ModuleSourceRef {
  readonly kind: CompiledDefinitionKind;
  readonly slug: string;
  readonly extensionNamespace?: string;
  readonly eventNames?: readonly string[];
  readonly description?: string;
}

export function compiledOf(
  node: { readonly definitions: readonly CompiledDefinition[] },
  kind: CompiledDefinitionKind,
): readonly CompiledDefinition[] {
  return node.definitions.filter((definition) => definition.kind === kind);
}

export type CompiledAgentNodeManifest = z.infer<typeof compiledAgentNodeManifestSchema>;

export type CompiledAgentResources = z.infer<typeof compiledAgentResourcesSchema>;

export type CompiledSubagentNode = Readonly<
  ModuleSourceRef &
    Node & {
      backing: { readonly kind: "resource"; readonly sourcePath: string };
      entryPath: string;
      name: string;
      owner: AgentSourceOwner;
      parentNodeId: string;
      rootPath: string;
    } & (
      | {
          agent: CompiledAgentNodeManifest;
          configResolver?: never;
          description: string;
        }
      | {
          agent: CompiledAgentResources;
          configResolver: CompiledDynamicSubagentDefinition;
          description?: never;
        }
    )
>;

export type { CompiledRemoteAgentNode } from "#compiler/remote-agent-node.js";

export type CompiledAgentManifest = z.infer<typeof compiledAgentManifestSchema>;

export interface CompiledExtensionMount {
  readonly externalDependencies: readonly string[];
  readonly namespace: string;
  readonly packageName: string;
  readonly specifier: string;
  readonly mountId: string;
  readonly sourceRoot: string;
  readonly mountSourceId: string;
  readonly mountSourcePath: string;
  readonly mountLogicalPath: string;
  readonly programmaticImport?: {
    readonly specifier: string;
    readonly entryPath: string;
    readonly config: JsonObject;
  };
}

export interface CreateCompiledAgentResourcesInput {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly channelRoutes: CompiledChannelRoutePlan;
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly definitions?: readonly CompiledDefinition[];
  readonly diagnosticsSummary?: DiscoverDiagnosticsSummary;
  readonly sourceComposition: AgentSourceComposition;
  readonly extensionMounts?: readonly CompiledExtensionMount[];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox: CompiledSandboxDefinition;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly scheduleCollections?: readonly CompiledScheduleCollectionDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly instructions?: readonly CompiledInstructionsDefinition[];
  readonly tools?: readonly CompiledToolDefinition[];
  readonly workspaceResourceRoot?: CompiledWorkspaceResourceRoot;
}

export function createCompiledAgentResources(
  input: CreateCompiledAgentResourcesInput,
): CompiledAgentResources {
  return {
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    bindings: { ...input.bindings },
    channelRoutes: {
      effective: [...input.channelRoutes.effective],
      preflight: [...input.channelRoutes.preflight],
      shadowed: [...input.channelRoutes.shadowed],
    },
    connections: [...(input.connections ?? [])],
    definitions: [...(input.definitions ?? [])],
    diagnosticsSummary: input.diagnosticsSummary ?? { errors: 0, warnings: 0 },
    extensionMounts: [...(input.extensionMounts ?? [])],
    instructions: [...(input.instructions ?? [])],
    remoteAgents: [...(input.remoteAgents ?? [])],
    sandbox: input.sandbox,
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    scheduleCollections: [...(input.scheduleCollections ?? [])],
    schedules: [...(input.schedules ?? [])],
    skills: [...(input.skills ?? [])],
    sourceComposition: { entries: [...input.sourceComposition.entries] },
    tools: [...(input.tools ?? [])],
    workspaceResourceRoot: input.workspaceResourceRoot ?? {
      logicalPath: "",
      rootEntries: deriveResourceRootEntries(input.sandboxWorkspaces ?? []),
    },
  };
}

export function createCompiledAgentNodeManifest(
  input: CreateCompiledAgentResourcesInput & { readonly config: CompiledAgentDefinition },
): CompiledAgentNodeManifest {
  const manifest = {
    ...createCompiledAgentResources(input),
    config: structuredClone(input.config),
  };
  validateCompiledAgentResources(manifest, { allowUnknownResourceWinners: true });
  return manifest;
}

export function deriveResourceRootEntries(
  sandboxWorkspaces: readonly CompiledSandboxWorkspace[],
): readonly string[] {
  const rootEntries = new Set(sandboxWorkspaces.flatMap((workspace) => workspace.rootEntries));
  return [...rootEntries].sort((left, right) => left.localeCompare(right));
}

export function createCompiledSubagentNodeId(parentNodeId: string, sourceId: string): string {
  if (parentNodeId === ROOT_COMPILED_AGENT_NODE_ID) {
    return sourceId;
  }

  return `${parentNodeId}::${sourceId}`;
}

export function createCompiledAgentManifest(
  input: CreateCompiledAgentResourcesInput & {
    readonly config: CompiledAgentDefinition;
    readonly subagents?: readonly CompiledSubagentNode[];
  },
): CompiledAgentManifest {
  const manifest: CompiledAgentManifest = {
    ...createCompiledAgentNodeManifest(input),
    kind: COMPILED_AGENT_MANIFEST_KIND,
    extensionMounts: [...(input.extensionMounts ?? [])],
    subagents: [...(input.subagents ?? [])],
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };
  validateCompiledAgentManifest(manifest);
  return manifest;
}
