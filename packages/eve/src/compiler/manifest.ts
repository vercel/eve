import { z } from "#compiled/zod/index.js";
import { mountIdSchema } from "#shared/extension-mount.js";

import {
  type DiscoverDiagnosticsSummary,
  discoverDiagnosticsSummarySchema,
} from "#discover/diagnostics.js";
import {
  type CompiledDynamicSubagentDefinition,
  compiledRemoteAgentNodeSchema,
  type CompiledRemoteAgentNode,
} from "#compiler/remote-agent-node.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { InternalInstructionsDefinition } from "#shared/instructions-definition.js";
import { jsonObjectSchema } from "#shared/json-schemas.js";
import type { JsonObject } from "#shared/json.js";
import type { Node } from "#shared/node.js";
import type {
  MarkdownSourceRef,
  ModuleSourceRef,
  SkillPackageSourceRef,
} from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import { WEB_SEARCH_FALLBACK_PROVIDERS, WEB_SEARCH_PROVIDERS } from "#shared/web-search.js";
import {
  AGENT_WORKFLOW_RETENTION_VALUES,
  ANTHROPIC_PROMPT_CACHE_TTLS,
  type InternalAgentDefinition,
  type InternalAgentModelDefinition,
  type InternalAgentCompactionDefinition,
  type AgentBuildDefinition,
  type ModelRouting,
} from "#shared/agent-definition.js";
import type { VercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";
import type {
  AgentModuleBacking,
  AgentSourceComposition,
  AgentSourceDescriptor,
  AgentSourceOwner,
  CompiledModuleBinding,
} from "#compiler/source-graph.js";
import {
  validateCompiledAgentManifest,
  validateCompiledAgentResources,
} from "#compiler/validate-artifact.js";

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
export const COMPILED_AGENT_MANIFEST_VERSION = 56;

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
type CompiledAgentBuildDefinition = AgentBuildDefinition;

/**
 * Normalized authored compaction configuration preserved in the compiled
 * manifest.
 */
type CompiledAgentCompactionDefinition = Omit<InternalAgentCompactionDefinition, "model"> & {
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
  | "hook"
  | "instructions"
  | "memory"
  | "skill"
  | "tool";

/**
 * A file the agent declares that eve asks at runtime: a `defineDynamic()` tool, skill,
 * connection, or instructions file, a hook, or a memory. Its module holds the code; this holds
 * what reading the agent needs without loading it.
 */
export interface CompiledDefinition extends ModuleSourceRef {
  readonly kind: CompiledDefinitionKind;
  /** Its name, from its path: `tools/weather.ts` is `"weather"`, `memory/notes.ts` `"notes"`. */
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

const agentSourceOwnerSchema: z.ZodType<AgentSourceOwner> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }).strict(),
  z.object({ feature: z.string().min(1), kind: z.literal("framework") }).strict(),
  z
    .object({
      kind: z.literal("extension"),
      mountId: mountIdSchema,
      namespace: z.string().min(1),
      packageName: z.string().min(1),
    })
    .strict(),
]);

const moduleSourceRefSchema: z.ZodType<ModuleSourceRef> = z
  .object({
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

const filesystemModuleBackingSchema = z
  .object({
    externalDependencies: z.array(z.string()).readonly(),
    extensionScope: z.object({ namespace: z.string(), sourceRoot: z.string() }).strict().optional(),
    mountId: z.string().optional(),
    kind: z.literal("filesystem"),
    sourcePath: z.string(),
  })
  .strict();

const programmaticModuleBackingSchema = z
  .object({
    kind: z.literal("programmatic"),
    mountId: z.string().optional(),
    moduleId: z.string(),
    registryId: z.string(),
    revision: z.string(),
    semanticRevision: z.string().optional(),
  })
  .strict();

const resourceSourceBackingSchema = z
  .object({ kind: z.literal("resource"), sourcePath: z.string() })
  .strict();

const agentModuleBackingSchema: z.ZodType<AgentModuleBacking> = z.discriminatedUnion("kind", [
  filesystemModuleBackingSchema,
  programmaticModuleBackingSchema,
]);

const compiledModuleBindingSchema: z.ZodType<CompiledModuleBinding> = z
  .object({
    backing: agentModuleBackingSchema,
    logicalPath: z.string(),
    owner: agentSourceOwnerSchema,
    usage: z
      .object({
        compile: z.boolean(),
        runtimeEntry: z.boolean(),
      })
      .strict(),
  })
  .strict();

const agentSourceDescriptorSchema: z.ZodType<AgentSourceDescriptor> = z
  .object({
    backing: z.discriminatedUnion("kind", [
      filesystemModuleBackingSchema,
      programmaticModuleBackingSchema,
      resourceSourceBackingSchema,
    ]),
    form: z.enum(["derived", "direct"]),
    layer: z.enum(["framework-default", "extension-package", "extension-override", "application"]),
    logicalPath: z.string(),
    owner: agentSourceOwnerSchema,
    sourceId: z.string(),
  })
  .strict();

const agentSourceCompositionSchema: z.ZodType<AgentSourceComposition> = z
  .object({
    entries: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("shadowed"),
              source: agentSourceDescriptorSchema,
              winnerSourceId: z.string(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("disabled"),
              source: agentSourceDescriptorSchema,
            })
            .strict(),
        ]),
      )
      .readonly(),
  })
  .strict();

const compiledDynamicModelDefinitionSchema: z.ZodType<CompiledDynamicModelDefinition> = z
  .object({
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

const channelMethodSchema = z.union([
  z.literal("GET"),
  z.literal("HEAD"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
  z.literal("OPTIONS"),
  z.literal("WEBSOCKET"),
]);

const compiledChannelCorsSchema = z
  .object({
    origin: z.union([z.literal("*"), z.literal("null"), z.array(z.string())]).optional(),
    methods: z.union([z.literal("*"), z.array(z.string())]).optional(),
    allowHeaders: z.union([z.literal("*"), z.array(z.string())]).optional(),
    exposeHeaders: z.union([z.literal("*"), z.array(z.string())]).optional(),
    credentials: z.boolean().optional(),
    maxAge: z.union([z.string(), z.literal(false)]).optional(),
    preflight: z
      .object({
        statusCode: z.number().int().min(100).max(599).optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<NormalizedChannelCorsOptions>;

const compiledVercelConnectMetadataSchema = z
  .object({
    connector: z.string(),
    requirement: z
      .object({
        method: z.string().optional(),
        reference: z.string(),
        service: z.string(),
        subjectTypes: z.array(z.enum(["app", "user"])).readonly(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<VercelConnectMetadata>;

const compiledChannelDefinitionSchema = z
  .object({
    kind: z.literal("channel"),
    name: z.string(),
    logicalPath: z.string(),
    method: channelMethodSchema,
    urlPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    exportName: z.string().optional(),
    adapterKind: z.string().optional(),
    cors: compiledChannelCorsSchema.optional(),
    manifest: jsonObjectSchema.optional(),
    vercelConnect: compiledVercelConnectMetadataSchema.optional(),
  })
  .strict();

const compiledChannelPreflightDefinitionSchema: z.ZodType<CompiledChannelPreflightDefinition> = z
  .object({
    cors: compiledChannelCorsSchema,
    method: z.literal("OPTIONS"),
    sourceIds: z.array(z.string()).readonly(),
    urlPath: z.string(),
  })
  .strict();

const compiledShadowedChannelRouteSchema: z.ZodType<CompiledShadowedChannelRoute> = z
  .object({
    method: channelMethodSchema,
    source: agentSourceDescriptorSchema,
    urlPath: z.string(),
    winnerSourceId: z.string(),
  })
  .strict();

const compiledChannelRoutePlanSchema: z.ZodType<CompiledChannelRoutePlan> = z
  .object({
    effective: z.array(compiledChannelDefinitionSchema).readonly(),
    preflight: z.array(compiledChannelPreflightDefinitionSchema).readonly(),
    shadowed: z.array(compiledShadowedChannelRouteSchema).readonly(),
  })
  .strict();

const modelRoutingSchema = z.union([
  z
    .object({
      kind: z.literal("gateway"),
      target: z.string(),
      byok: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      provider: z.string(),
    })
    .strict(),
]) satisfies z.ZodType<ModelRouting>;

const compiledRuntimeModelReferenceSchema: z.ZodType<CompiledRuntimeModelReference> = z
  .object({
    contextWindowTokens: z.number().int().positive().optional(),
    id: z.string(),
    source: moduleSourceRefSchema.optional(),
    sourceField: z.literal("compaction.model").optional(),
    promptCache: z
      .object({
        anthropic: z
          .object({ ttl: z.literal(ANTHROPIC_PROMPT_CACHE_TTLS).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    providerOptions: z.record(z.string(), jsonObjectSchema).optional(),
    routing: modelRoutingSchema,
  })
  .strict();

const compiledAgentBuildDefinitionSchema: z.ZodType<CompiledAgentBuildDefinition> = z
  .object({
    externalDependencies: z.array(z.string()).optional(),
  })
  .strict();

const compiledAgentWorkflowWorldDefinitionSchema = z.string();

const compiledAgentWorkflowDefinitionSchema = z
  .object({
    modelCallsPerStep: z.number().int().positive().optional(),
    retention: z.literal(AGENT_WORKFLOW_RETENTION_VALUES).optional(),
    world: compiledAgentWorkflowWorldDefinitionSchema.optional(),
  })
  .strict();

const compiledAgentCompactionDefinitionSchema: z.ZodType<CompiledAgentCompactionDefinition> = z
  .object({
    model: compiledRuntimeModelReferenceSchema.optional(),
    thresholdPercent: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const sessionTimeoutSchema = z.union([z.number().int().positive(), z.literal(false)]);

const compiledAgentLimitsDefinitionSchema = z
  .object({
    sessionTimeoutMs: sessionTimeoutSchema.optional(),
    sessionUsage: z.boolean().optional(),
  })
  .strict();

const compiledAgentConfigBaseFields = {
  approval: z.boolean().optional(),
  build: compiledAgentBuildDefinitionSchema.optional(),
  compaction: compiledAgentCompactionDefinitionSchema.optional(),
  defaultTools: z.boolean().optional(),
  description: z.string().optional(),
  experimental: z
    .object({
      workflow: compiledAgentWorkflowDefinitionSchema.optional(),
    })
    .strict()
    .optional(),
  name: z.string(),
  reasoning: z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  source: moduleSourceRefSchema,
  tool: z.union([z.boolean(), z.literal("deferred")]).optional(),
  limits: compiledAgentLimitsDefinitionSchema.optional(),
};

const compiledAgentConfigSchema: z.ZodType<CompiledAgentDefinition> = z.union([
  z
    .object({
      ...compiledAgentConfigBaseFields,
      model: compiledRuntimeModelReferenceSchema,
    })
    .strict(),
  z
    .object({
      ...compiledAgentConfigBaseFields,
      dynamicModel: compiledDynamicModelDefinitionSchema,
    })
    .strict(),
]);

const compiledInstructionsBaseFields = {
  content: z.string(),
  name: z.string(),
  logicalPath: z.string(),
  role: z.enum(["system", "user"]),
  sourceId: z.string(),
};

const compiledInstructionsSchema: z.ZodType<CompiledInstructionsDefinition> = z.discriminatedUnion(
  "sourceKind",
  [
    z
      .object({
        ...compiledInstructionsBaseFields,
        owner: agentSourceOwnerSchema,
        sourceKind: z.literal("markdown"),
      })
      .strict(),
    z
      .object({
        ...compiledInstructionsBaseFields,
        sourceKind: z.literal("module"),
      })
      .strict(),
  ],
);

const compiledSkillBaseFields = {
  name: z.string(),
  deferred: z.boolean().optional(),
  description: z.string(),
  license: z.string().optional(),
  content: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  sourceId: z.string(),
  logicalPath: z.string(),
};

const compiledSkillSourceSchema: z.ZodType<CompiledSkillDefinition> = z.discriminatedUnion(
  "sourceKind",
  [
    z
      .object({
        ...compiledSkillBaseFields,
        owner: agentSourceOwnerSchema,
        sourceKind: z.literal("markdown"),
      })
      .strict(),
    z
      .object({
        ...compiledSkillBaseFields,
        sourceKind: z.literal("module"),
        exportName: z.string().optional(),
      })
      .strict(),
    z
      .object({
        ...compiledSkillBaseFields,
        owner: agentSourceOwnerSchema,
        sourceKind: z.literal("skill-package"),
        skillId: z.string(),
        skillFilePath: z.string(),
        rootPath: z.string(),
        assetsPath: z.string().optional(),
        referencesPath: z.string().optional(),
        scriptsPath: z.string().optional(),
      })
      .strict(),
  ],
);

const compiledScheduleBaseFields = {
  cron: z.string(),
  hasRun: z.boolean(),
  name: z.string(),
  logicalPath: z.string(),
  markdown: z.string().optional(),
  sourceId: z.string(),
};

const compiledScheduleDefinitionSchema = z.discriminatedUnion("sourceKind", [
  z
    .object({
      ...compiledScheduleBaseFields,
      owner: agentSourceOwnerSchema,
      sourceKind: z.literal("markdown"),
    })
    .strict(),
  z
    .object({
      ...compiledScheduleBaseFields,
      sourceKind: z.literal("module"),
    })
    .strict(),
]);

const compiledScheduleCollectionDefinitionSchema = z
  .object({
    /** The agent the collection's schedules belong to, which their namespace names. */
    application: z.string(),
    description: z.string().optional(),
    logicalPath: z.string(),
    name: z.string(),
    providerKind: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    tools: z.union([z.boolean(), z.literal("deferred")]).optional(),
  })
  .strict();

const compiledSandboxDefinitionSchema = z
  .object({
    /** Stable provider name from the exported environment. */
    providerName: z.string().optional(),
    environmentExportName: z.string().optional(),
    inheritsParent: z.boolean().optional(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    revisionHash: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledSandboxWorkspaceSchema = z
  .object({
    logicalPath: z.string(),
    rootEntries: z.array(z.string()).readonly(),
    sourceId: z.string(),
    sourcePath: z.string(),
  })
  .strict();

const compiledWorkspaceResourceRootSchema = z
  .object({
    contentHash: z.string().optional(),
    logicalPath: z.string(),
    rootEntries: z.array(z.string()).readonly(),
  })
  .strict();

const compiledConnectionDefinitionSchema = z
  .object({
    experimental_events: z.literal(true).optional(),
    connectionName: z.string(),
    description: z.string(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    /**
     * Wire protocol the connection speaks. Defaults to `"mcp"` so
     * manifests produced before the discriminator existed continue to
     * load as MCP connections. `"openapi"` selects the OpenAPI client at
     * runtime.
     */
    protocol: z.enum(["mcp", "openapi"]).default("mcp"),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    /**
     * Endpoint the connection talks to: the MCP server URL for MCP
     * connections, the API base URL for OpenAPI connections.
     */
    url: z.string(),
    /**
     * Marker the compiler captures when the connection's `auth` is built
     * by `connect()` from `@vercel/connect/eve`. The `connector` field
     * carries whatever the author wrote — UID (`"oauth/mcp-linear-app"`)
     * or opaque service-connector key (`"scl_..."`); both forms address
     * the same connector on the Vercel Connect side.
     */
    vercelConnect: compiledVercelConnectMetadataSchema.optional(),
  })
  .strict();

const compiledToolBehaviorSchema: z.ZodType<CompiledToolBehavior> = z
  .object({
    availability: z.array(z.literal("root-session")).readonly(),
    handling: z
      .discriminatedUnion("kind", [
        z
          .object({
            action: z.literal("self-agent"),
            kind: z.literal("dispatch"),
          })
          .strict(),
        z
          .object({
            fallback: z.enum(WEB_SEARCH_FALLBACK_PROVIDERS).optional(),
            kind: z.literal("provider-tool"),
            provider: z.enum(WEB_SEARCH_PROVIDERS),
          })
          .strict(),
        z
          .object({
            entryPoint: z.enum(["execute", "task", "serve"]),
            kind: z.literal("workflow-tool"),
            workflowId: z.string(),
          })
          .strict(),
      ])
      .optional(),
    shape: z
      .object({
        suspend: z.enum(["none", "workflow"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const compiledToolDefinitionSchema = z
  .object({
    availableInSubagents: z.boolean().optional(),
    behavior: compiledToolBehaviorSchema.optional(),
    deferred: z.boolean().optional(),
    description: z.string(),
    exportName: z.string().optional(),
    hasExecute: z.boolean(),
    hasModelOutputProjection: z.boolean(),
    inputSchema: jsonObjectSchema.nullable(),
    logicalPath: z.string(),
    modelInputSchema: jsonObjectSchema.optional(),
    name: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    requiresApproval: z.boolean(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    workflowProgram: z
      .object({
        maxSubagents: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const compiledDefinitionSchema: z.ZodType<CompiledDefinition> = z
  .object({
    description: z.string().optional(),
    eventNames: z.array(z.string()).readonly().optional(),
    exportName: z.string().optional(),
    extensionNamespace: z.string().optional(),
    kind: z.enum(["connection", "hook", "instructions", "memory", "skill", "tool"]),
    logicalPath: z.string(),
    slug: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledExtensionMountSchema: z.ZodType<CompiledExtensionMount> = z
  .object({
    externalDependencies: z.array(z.string()).readonly(),
    namespace: z.string(),
    packageName: z.string(),
    specifier: z.string(),
    mountId: mountIdSchema,
    sourceRoot: z.string(),
    mountSourceId: z.string(),
    mountSourcePath: z.string(),
    mountLogicalPath: z.string(),
    programmaticImport: z
      .object({
        specifier: z.string(),
        entryPath: z.string(),
        config: jsonObjectSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Zod schema for one non-recursive compiled authored agent payload.
 */
const compiledAgentResourceFields = {
  agentRoot: z.string(),
  appRoot: z.string(),
  bindings: z.record(z.string(), compiledModuleBindingSchema),
  channelRoutes: compiledChannelRoutePlanSchema,
  connections: z.array(compiledConnectionDefinitionSchema),
  definitions: z.array(compiledDefinitionSchema),
  diagnosticsSummary: discoverDiagnosticsSummarySchema,
  sourceComposition: agentSourceCompositionSchema,
  extensionMounts: z.array(compiledExtensionMountSchema).default([]),
  sandbox: compiledSandboxDefinitionSchema,
  sandboxWorkspaces: z.array(compiledSandboxWorkspaceSchema),
  schedules: z.array(compiledScheduleDefinitionSchema),
  scheduleCollections: z.array(compiledScheduleCollectionDefinitionSchema).default([]),
  remoteAgents: z.array(compiledRemoteAgentNodeSchema),
  skills: z.array(compiledSkillSourceSchema).readonly(),
  instructions: z.array(compiledInstructionsSchema).readonly().default([]),
  tools: z.array(compiledToolDefinitionSchema),
  workspaceResourceRoot: compiledWorkspaceResourceRootSchema,
};

const compiledAgentResourcesSchema = z.object(compiledAgentResourceFields).strict();

const compiledAgentNodeManifestSchema = z
  .object({
    ...compiledAgentResourceFields,
    config: compiledAgentConfigSchema,
  })
  .strict();

const compiledSubagentNodeBaseFields = {
  backing: resourceSourceBackingSchema,
  entryPath: z.string(),
  logicalPath: z.string(),
  name: z.string(),
  nodeId: z.string(),
  owner: agentSourceOwnerSchema,
  parentNodeId: z.string(),
  rootPath: z.string(),
  sourceId: z.string(),
  sourceKind: z.literal("module"),
  exportName: z.string().optional(),
};
const compiledDynamicSubagentDefinitionSchema = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();
const compiledSubagentNodeSchema: z.ZodType<CompiledSubagentNode> = z.union([
  z
    .object({
      ...compiledSubagentNodeBaseFields,
      agent: compiledAgentNodeManifestSchema,
      description: z.string(),
    })
    .strict(),
  z
    .object({
      ...compiledSubagentNodeBaseFields,
      agent: compiledAgentResourcesSchema,
      configResolver: compiledDynamicSubagentDefinitionSchema,
    })
    .strict(),
]);

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

/**
 * Zod schema for the versioned compiled manifest emitted by the compiler.
 */
export const compiledAgentManifestSchema = z
  .object({
    ...compiledAgentResourceFields,
    config: compiledAgentConfigSchema,
    kind: z.literal(COMPILED_AGENT_MANIFEST_KIND),
    subagents: z.array(compiledSubagentNodeSchema),
    version: z.literal(COMPILED_AGENT_MANIFEST_VERSION),
  })
  .strict();

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
