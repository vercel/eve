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

/**
 * Stable manifest kind emitted by the compiler for runtime loading.
 */
export const COMPILED_AGENT_MANIFEST_KIND = "eve-agent-compiled-manifest";

/**
 * Stable node id used by compiled artifacts for the root authored agent.
 */
export const ROOT_COMPILED_AGENT_NODE_ID = "__root__";

/**
 * Current compiled manifest schema version.
 */
export const COMPILED_AGENT_MANIFEST_VERSION = 57;

/**
 * Active compiled channel entry — backed by an authored `Channel` module.
 */
export interface CompiledChannelDefinition {
  readonly kind: "channel";
  readonly name: string;
  readonly logicalPath: string;
  readonly method: ChannelRouteMethod;
  readonly urlPath: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
  readonly exportName?: string;
  /**
   * Stable identifier of the `ChannelAdapter.kind` returned by the authored
   * route, captured at compile time. Examples: `"slack"`, `"http"`. Authors
   * may override the default kind on their adapter, so this field is the
   * adapter's reported value verbatim. Consumers (eg. dashboard surfaces)
   * normalize it for display via {@link normalizeChannelKindForDisplay}.
   *
   * Omitted when the route does not register an adapter.
   */
  readonly adapterKind?: string;
  /**
   * Serializable CORS options to apply to this channel route. Omitted when the
   * channel leaves CORS untouched.
   */
  readonly cors?: NormalizedChannelCorsOptions;
  readonly manifest?: JsonObject;
  readonly vercelConnect?: VercelConnectMetadata;
}

/**
 * Disabled compiled channel entry — marker that an authored file at this
 * slug exported `disableRoute()` to remove the matching framework default.
 */
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

/**
 * Serializable runtime model reference preserved in the compiled manifest.
 *
 * Carries {@link ModelRouting} — decided at compile time from the authored model
 * value — so consumers (the dev server's `/eve/v1/info`, the TUI) can tell how
 * the model is reached without re-resolving it. Runtime model resolution uses
 * the routing-free {@link InternalAgentModelDefinition}; routing is a
 * compiled-output concern only.
 */
export type CompiledRuntimeModelReference = InternalAgentModelDefinition & {
  routing: ModelRouting;
};

/**
 * Dynamic model resolver source preserved in the compiled manifest.
 */
export type CompiledDynamicModelDefinition = ModuleSourceRef;

/**
 * Normalized hosted-build configuration preserved in the compiled manifest.
 */
export type CompiledAgentBuildDefinition = AgentBuildDefinition;

/**
 * Normalized authored compaction configuration preserved in the compiled
 * manifest.
 */
export type CompiledAgentCompactionDefinition = Omit<InternalAgentCompactionDefinition, "model"> & {
  model?: CompiledRuntimeModelReference;
};

/**
 * Normalized additive agent configuration preserved in the compiled manifest.
 */
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

/**
 * Normalized authored instructions prompt preserved in the compiled
 * manifest.
 */
export type CompiledInstructionsDefinition = InternalInstructionsDefinition &
  (
    | (Omit<MarkdownSourceRef<undefined>, "definition"> & {
        readonly owner: AgentSourceOwner;
      })
    | Omit<ModuleSourceRef, "exportName">
  );

/**
 * Normalized authored skill preserved in the compiled manifest.
 */
export type CompiledSkillDefinition = NamedSkillDefinition &
  (
    | (Omit<MarkdownSourceRef<undefined>, "definition"> & {
        readonly owner: AgentSourceOwner;
      })
    | ModuleSourceRef
    | (SkillPackageSourceRef & { readonly owner: AgentSourceOwner })
  );

/**
 * Normalized authored schedule preserved in the compiled manifest.
 */
export type CompiledScheduleDefinition = z.infer<typeof compiledScheduleDefinitionSchema>;
export type CompiledScheduleCollectionDefinition = z.infer<
  typeof compiledScheduleCollectionDefinitionSchema
>;

/**
 * Normalized authored sandbox metadata preserved in the compiled manifest.
 */
export type CompiledSandboxDefinition = z.infer<typeof compiledSandboxDefinitionSchema>;

/**
 * Compiled sandbox workspace folder preserved in the compiled manifest.
 *
 * Corresponds to the `agent/sandbox/workspace/` directory discovered on
 * disk. Mounted into the live sandbox cwd at session bootstrap.
 */
type CompiledSandboxWorkspace = z.infer<typeof compiledSandboxWorkspaceSchema>;

/**
 * Byte-free descriptor for the compiled workspace resource tree owned by one
 * graph node.
 */
export type CompiledWorkspaceResourceRoot = z.infer<typeof compiledWorkspaceResourceRootSchema>;

/**
 * Normalized authored connection metadata preserved in the compiled manifest.
 */
export type CompiledConnectionDefinition = z.infer<typeof compiledConnectionDefinitionSchema>;

/**
 * Normalized authored tool metadata preserved in the compiled manifest.
 */
export type CompiledToolDefinition = InternalToolDefinition &
  ModuleSourceRef & {
    readonly behavior?: CompiledToolBehavior;
    readonly hasExecute: boolean;
    readonly hasModelOutputProjection: boolean;
    /** The input schema as eve sends it to a model; absent for provider-managed tools. */
    readonly modelInputSchema?: JsonObject;
    readonly requiresApproval: boolean;
    readonly workflowProgram?: {
      readonly maxSubagents: number;
    };
  };

/** The kinds of file eve asks at runtime, each a definition of the agent's. */
export type CompiledDefinitionKind =
  | "connection"
  | "harness"
  | "hook"
  | "instructions"
  | "memory"
  | "skill"
  | "tool";

/**
 * A file the agent declares that eve asks at runtime: a `defineDynamic()` tool, skill,
 * connection, or instructions file, a hook, a memory, or a harness layer. Its module holds the code; this holds
 * what reading the agent needs without loading it.
 */
export interface CompiledDefinition extends ModuleSourceRef {
  readonly kind: CompiledDefinitionKind;
  /**
   * Its name, from its path: `tools/weather.ts` is `"weather"`, `memory/notes.ts` `"notes"`,
   * `harness.ts` `"harness"`, and an extension's `harness/<namespace>.ts` `"<namespace>"`.
   */
  readonly slug: string;
  /** An extension's namespace, which the names of what a map returns take. */
  readonly extensionNamespace?: string;
  /** A hook's events. */
  readonly eventNames?: readonly string[];
  /** A memory's description. */
  readonly description?: string;
}

/** A node's definitions of one kind, in the order it declares them. */
export function compiledOf(
  node: { readonly definitions: readonly CompiledDefinition[] },
  kind: CompiledDefinitionKind,
): readonly CompiledDefinition[] {
  return node.definitions.filter((definition) => definition.kind === kind);
}

/**
 * Non-recursive compiled authored agent payload shared by the root agent and
 * every flattened subagent node.
 */
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

/**
 * Versioned compiled manifest emitted by the compiler and loaded by runtime.
 */
export type CompiledAgentManifest = z.infer<typeof compiledAgentManifestSchema>;

/**
 * One mounted extension recorded on a compiled agent manifest. The runtime
 * evaluates {@link mountLogicalPath} at module-map load so the mount's factory
 * call binds the extension's config on its instance handle before any tool runs.
 */
export interface CompiledExtensionMount {
  /** Runtime packages this extension requires the consuming application to externalize. */
  readonly externalDependencies: readonly string[];
  /** Mount-derived namespace that prefixes the extension's tool/skill names. */
  readonly namespace: string;
  readonly packageName: string;
  /** Package export imported by the mount declaration. */
  readonly specifier: string;
  /** Canonical path of this mount in the root agent tree. */
  readonly mountId: string;
  /** Absolute path to the extension's distributed source root. */
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

/** Creates compiled filesystem-owned resources with stable defaults. */
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

/** Creates a compiled authored agent payload with stable defaults. */
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

/**
 * The sorted root entries of a node's workspace resource tree. The in-memory manifest factory and
 * `materializeWorkspaceResources` both use it, so both emit identical descriptors.
 */
export function deriveResourceRootEntries(
  sandboxWorkspaces: readonly CompiledSandboxWorkspace[],
): readonly string[] {
  const rootEntries = new Set(sandboxWorkspaces.flatMap((workspace) => workspace.rootEntries));
  return [...rootEntries].sort((left, right) => left.localeCompare(right));
}

/**
 * Creates one stable compiled subagent node id from the parent node id and the
 * source entry discovered in that parent package.
 */
export function createCompiledSubagentNodeId(parentNodeId: string, sourceId: string): string {
  if (parentNodeId === ROOT_COMPILED_AGENT_NODE_ID) {
    return sourceId;
  }

  return `${parentNodeId}::${sourceId}`;
}

/**
 * Creates a compiled manifest with stable defaults.
 */
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
