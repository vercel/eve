import { z } from "#compiled/zod/index.js";

import {
  type DiscoverDiagnosticsSummary,
  discoverDiagnosticsSummarySchema,
} from "#discover/diagnostics.js";
import {
  compiledRemoteAgentNodeSchema,
  type CompiledRemoteAgentNode,
} from "#compiler/remote-agent-node.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { InternalInstructionsDefinition } from "#shared/instructions-definition.js";
import { jsonObjectSchema } from "#shared/json-schemas.js";
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
import type { InternalToolDefinition } from "#shared/tool-definition.js";

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
export const COMPILED_AGENT_MANIFEST_VERSION = 36;

/**
 * Compiled channel entry preserved in the compiled manifest.
 */
export type CompiledChannelEntry = CompiledChannelDefinition | DisabledCompiledChannelEntry;

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
}

/**
 * Disabled compiled channel entry — marker that an authored file at this
 * slug exported `disableRoute()` to remove the matching framework default.
 */
interface DisabledCompiledChannelEntry {
  readonly kind: "disabled";
  readonly name: string;
  readonly logicalPath: string;
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
 * Dynamic model resolver source preserved in the compiled manifest; the
 * compiled `config.model` remains the fallback model.
 */
export type CompiledDynamicModelDefinition = ModuleSourceRef & {
  readonly eventNames: readonly string[];
};

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
export type CompiledAgentDefinition = Omit<InternalAgentDefinition, "model" | "compaction"> & {
  model: CompiledRuntimeModelReference;
  compaction?: CompiledAgentCompactionDefinition;
  dynamicModel?: CompiledDynamicModelDefinition;
};

/**
 * Normalized authored instructions prompt preserved in the compiled
 * manifest.
 */
export type CompiledInstructionsDefinition = InternalInstructionsDefinition &
  (Omit<MarkdownSourceRef<undefined>, "definition"> | Omit<ModuleSourceRef, "exportName">);

/**
 * Normalized authored skill preserved in the compiled manifest.
 */
export type CompiledSkillDefinition = NamedSkillDefinition &
  (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef | SkillPackageSourceRef);

/**
 * Normalized authored schedule preserved in the compiled manifest.
 */
export type CompiledScheduleDefinition = z.infer<typeof compiledScheduleDefinitionSchema>;

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
export type CompiledToolDefinition = InternalToolDefinition & ModuleSourceRef;

/**
 * Serializable configuration for the experimental framework `Workflow` tool.
 */
export interface CompiledWorkflowToolDefinition {
  readonly maxSubagents?: number;
}

/**
 * Compiled dynamic tool resolver entry. The resolver function lives in the
 * compiled module map; the manifest entry carries only the metadata needed
 * to load and invoke it at runtime.
 */
export interface CompiledDynamicToolDefinition extends ModuleSourceRef {
  readonly slug: string;
  readonly eventNames: readonly string[];
  /**
   * Mount namespace when this resolver comes from an extension. The runtime
   * prefixes the names of tools the resolver produces (`forecast` →
   * `crm__forecast`) so extension-produced tools are namespaced like every
   * other extension contribution. Absent for consumer-authored resolvers.
   */
  readonly extensionNamespace?: string;
}

/**
 * Compiled dynamic skill resolver entry. Mirrors
 * {@link CompiledDynamicToolDefinition} — the resolver produces skill
 * packages at runtime rather than tool definitions.
 */
export interface CompiledDynamicSkillDefinition extends ModuleSourceRef {
  readonly slug: string;
  readonly eventNames: readonly string[];
  /**
   * Mount namespace when this resolver comes from an extension. Names of skills
   * a map resolver produces are prefixed with `${extensionNamespace}__`.
   */
  readonly extensionNamespace?: string;
}

/**
 * Compiled dynamic instructions resolver entry. The resolver produces
 * {@link ModelMessage[]} at runtime rather than static markdown.
 */
export interface CompiledDynamicInstructionsDefinition extends ModuleSourceRef {
  readonly slug: string;
  readonly eventNames: readonly string[];
}

/**
 * Normalized authored hook entry preserved in the compiled manifest.
 *
 * Hook event handlers are arbitrary functions — there is no static
 * shape the compiler can validate beyond the source ref. Per-handler
 * resolution happens at runtime via {@link resolveHookDefinition}.
 */
export interface CompiledHookDefinition extends ModuleSourceRef {
  /**
   * Path-relative slug used for diagnostics and ordering. Derived from
   * the authored file's logical path
   * (eg. `agent/hooks/auth/guard.ts` → `"auth/guard"`).
   */
  readonly slug: string;
}

/**
 * Non-recursive compiled authored agent payload shared by the root agent and
 * every flattened subagent node.
 */
export type CompiledAgentNodeManifest = z.infer<typeof compiledAgentNodeManifestSchema>;

/**
 * Flattened compiled subagent node emitted by the compiler. `name` and
 * `description` are copied from `agent.config` for fast registry lookup.
 */
export type CompiledSubagentNode = Readonly<
  ModuleSourceRef &
    Node & {
      agent: CompiledAgentNodeManifest;
      description: string;
      entryPath: string;
      name: string;
      rootPath: string;
    }
>;

export type { CompiledRemoteAgentNode } from "#compiler/remote-agent-node.js";

/**
 * Parent-child edge connecting two compiled agent nodes.
 */
export interface CompiledSubagentEdge {
  readonly childNodeId: string;
  readonly parentNodeId: string;
}

/**
 * Versioned compiled manifest emitted by the compiler and loaded by runtime.
 */
export type CompiledAgentManifest = z.infer<typeof compiledAgentManifestSchema>;

const moduleSourceRefSchema: z.ZodType<ModuleSourceRef> = z
  .object({
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

const compiledDynamicModelDefinitionSchema: z.ZodType<CompiledDynamicModelDefinition> = z
  .object({
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

const channelMethodSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
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
  })
  .strict();

const disabledCompiledChannelEntrySchema = z
  .object({
    kind: z.literal("disabled"),
    name: z.string(),
    logicalPath: z.string(),
  })
  .strict();

const compiledChannelEntrySchema = z.union([
  compiledChannelDefinitionSchema,
  disabledCompiledChannelEntrySchema,
]) as unknown as z.ZodType<CompiledChannelEntry>;

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
    world: compiledAgentWorkflowWorldDefinitionSchema.optional(),
  })
  .strict();

const compiledAgentCompactionDefinitionSchema: z.ZodType<CompiledAgentCompactionDefinition> = z
  .object({
    model: compiledRuntimeModelReferenceSchema.optional(),
    thresholdPercent: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const sessionTokenLimitSchema = z.union([z.number().int().positive(), z.literal(false)]);

const compiledAgentLimitsDefinitionSchema = z
  .object({
    maxInputTokensPerSession: sessionTokenLimitSchema.optional(),
    maxOutputTokensPerSession: sessionTokenLimitSchema.optional(),
  })
  .strict();

const compiledWorkflowToolDefinitionSchema: z.ZodType<CompiledWorkflowToolDefinition> = z
  .object({
    maxSubagents: z.number().int().positive().optional(),
  })
  .strict();

const compiledAgentConfigSchema: z.ZodType<CompiledAgentDefinition> = z
  .object({
    build: compiledAgentBuildDefinitionSchema.optional(),
    compaction: compiledAgentCompactionDefinitionSchema.optional(),
    description: z.string().optional(),
    dynamicModel: compiledDynamicModelDefinitionSchema.optional(),
    experimental: z
      .object({
        workflow: compiledAgentWorkflowDefinitionSchema.optional(),
      })
      .strict()
      .optional(),
    model: compiledRuntimeModelReferenceSchema,
    name: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    source: moduleSourceRefSchema.optional(),
    limits: compiledAgentLimitsDefinitionSchema.optional(),
  })
  .strict();

const compiledInstructionsSchema: z.ZodType<CompiledInstructionsDefinition> = z
  .object({
    name: z.string(),
    logicalPath: z.string(),
    markdown: z.string(),
    sourceId: z.string(),
    sourceKind: z.union([z.literal("markdown"), z.literal("module")]),
  })
  .strict();

const compiledSkillBaseFields = {
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  markdown: z.string(),
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

const compiledScheduleDefinitionSchema = z
  .object({
    cron: z.string(),
    hasRun: z.boolean(),
    name: z.string(),
    logicalPath: z.string(),
    markdown: z.string().optional(),
    sourceId: z.string(),
    sourceKind: z.union([z.literal("markdown"), z.literal("module")]),
  })
  .strict();

const compiledSandboxDefinitionSchema = z
  .object({
    /**
     * Stable name of the authored backend (`"local"`, `"vercel"`,
     * `"local-just-bash"`, or a custom backend's name), captured at
     * compile time so build pipelines can make backend-aware decisions
     * (for example including the optional just-bash engine package in
     * hosted output). Absent when the definition omits `backend` or the
     * backend's name could not be resolved at compile time.
     */
    backendName: z.string().optional(),
    description: z.string().optional(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    revalidationKey: z.string().optional(),
    sourceHash: z.string(),
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
    vercelConnect: z
      .object({
        connector: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const compiledToolDefinitionSchema = z
  .object({
    description: z.string(),
    exportName: z.string().optional(),
    inputSchema: jsonObjectSchema.nullable(),
    logicalPath: z.string(),
    name: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledDynamicToolDefinitionSchema: z.ZodType<CompiledDynamicToolDefinition> = z
  .object({
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
    extensionNamespace: z.string().optional(),
    logicalPath: z.string(),
    slug: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledDynamicSkillDefinitionSchema: z.ZodType<CompiledDynamicSkillDefinition> = z
  .object({
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
    extensionNamespace: z.string().optional(),
    logicalPath: z.string(),
    slug: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledDynamicInstructionsDefinitionSchema: z.ZodType<CompiledDynamicInstructionsDefinition> =
  z
    .object({
      eventNames: z.array(z.string()).readonly(),
      exportName: z.string().optional(),
      logicalPath: z.string(),
      slug: z.string(),
      sourceId: z.string(),
      sourceKind: z.literal("module"),
    })
    .strict();

const compiledHookDefinitionSchema: z.ZodType<CompiledHookDefinition> = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    slug: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

/**
 * Zod schema for one non-recursive compiled authored agent payload.
 */
const compiledAgentNodeManifestSchema = z
  .object({
    agentRoot: z.string(),
    appRoot: z.string(),
    channels: z.array(compiledChannelEntrySchema),
    config: compiledAgentConfigSchema,
    connections: z.array(compiledConnectionDefinitionSchema),
    diagnosticsSummary: discoverDiagnosticsSummarySchema,
    disabledFrameworkTools: z.array(z.string()).readonly(),
    workflowTool: compiledWorkflowToolDefinitionSchema.optional(),
    dynamicInstructions: z.array(compiledDynamicInstructionsDefinitionSchema).default([]),
    dynamicSkills: z.array(compiledDynamicSkillDefinitionSchema).default([]),
    dynamicTools: z.array(compiledDynamicToolDefinitionSchema).default([]),
    hooks: z.array(compiledHookDefinitionSchema),
    sandbox: compiledSandboxDefinitionSchema.nullable(),
    sandboxWorkspaces: z.array(compiledSandboxWorkspaceSchema),
    schedules: z.array(compiledScheduleDefinitionSchema),
    remoteAgents: z.array(compiledRemoteAgentNodeSchema),
    skills: z.array(compiledSkillSourceSchema).readonly(),
    instructions: compiledInstructionsSchema.optional(),
    tools: z.array(compiledToolDefinitionSchema),
    workspaceResourceRoot: compiledWorkspaceResourceRootSchema,
  })
  .strict();

const compiledSubagentNodeSchema: z.ZodType<CompiledSubagentNode> = z
  .object({
    agent: compiledAgentNodeManifestSchema,
    description: z.string(),
    entryPath: z.string(),
    logicalPath: z.string(),
    name: z.string(),
    nodeId: z.string(),
    rootPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
    exportName: z.string().optional(),
  })
  .strict();

const compiledSubagentEdgeSchema: z.ZodType<CompiledSubagentEdge> = z
  .object({
    childNodeId: z.string(),
    parentNodeId: z.string(),
  })
  .strict();

/**
 * One mounted extension recorded on the root compiled manifest. The runtime
 * evaluates {@link mountLogicalPath} at module-map load so the mount's factory
 * call binds the extension's config before any tool runs.
 */
export interface CompiledExtensionMount {
  /** Mount-derived namespace that prefixes the extension's tool/skill names. */
  readonly namespace: string;
  readonly packageName: string;
  /**
   * Package-derived namespace that scopes the extension's durable state keys and
   * config binding. Distinct from {@link namespace}: state stays keyed to the
   * package so a consumer renaming the mount file cannot orphan persisted state.
   */
  readonly packageNamespace: string;
  /**
   * Absolute path to the extension's source root on disk. The extension-scope
   * bundler plugin treats any module under this root as extension-owned and
   * rewrites its `eve/context`/`eve/extension` imports to bake in the namespace.
   */
  readonly sourceRoot: string;
  readonly mountSourceId: string;
  readonly mountLogicalPath: string;
}

const compiledExtensionMountSchema: z.ZodType<CompiledExtensionMount> = z
  .object({
    namespace: z.string(),
    packageName: z.string(),
    packageNamespace: z.string(),
    sourceRoot: z.string(),
    mountSourceId: z.string(),
    mountLogicalPath: z.string(),
  })
  .strict();

/**
 * Zod schema for the versioned compiled manifest emitted by the compiler.
 */
export const compiledAgentManifestSchema = z
  .object({
    agentRoot: z.string(),
    appRoot: z.string(),
    extensionMounts: z.array(compiledExtensionMountSchema).default([]),
    channels: z.array(compiledChannelEntrySchema),
    config: compiledAgentConfigSchema,
    connections: z.array(compiledConnectionDefinitionSchema),
    diagnosticsSummary: discoverDiagnosticsSummarySchema,
    disabledFrameworkTools: z.array(z.string()).readonly(),
    workflowTool: compiledWorkflowToolDefinitionSchema.optional(),
    dynamicInstructions: z.array(compiledDynamicInstructionsDefinitionSchema).default([]),
    dynamicSkills: z.array(compiledDynamicSkillDefinitionSchema).default([]),
    dynamicTools: z.array(compiledDynamicToolDefinitionSchema).default([]),
    hooks: z.array(compiledHookDefinitionSchema),
    kind: z.literal(COMPILED_AGENT_MANIFEST_KIND),
    remoteAgents: z.array(compiledRemoteAgentNodeSchema),
    sandbox: compiledSandboxDefinitionSchema.nullable(),
    sandboxWorkspaces: z.array(compiledSandboxWorkspaceSchema),
    schedules: z.array(compiledScheduleDefinitionSchema),
    skills: z.array(compiledSkillSourceSchema).readonly(),
    subagentEdges: z.array(compiledSubagentEdgeSchema),
    subagents: z.array(compiledSubagentNodeSchema),
    instructions: compiledInstructionsSchema.optional(),
    tools: z.array(compiledToolDefinitionSchema),
    version: z.literal(COMPILED_AGENT_MANIFEST_VERSION),
    workspaceResourceRoot: compiledWorkspaceResourceRootSchema,
  })
  .strict();

/**
 * Creates a compiled authored agent payload with stable defaults.
 */
export function createCompiledAgentNodeManifest(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly channels?: readonly CompiledChannelEntry[];
  readonly config: CompiledAgentDefinition;
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly diagnosticsSummary?: DiscoverDiagnosticsSummary;
  readonly disabledFrameworkTools?: readonly string[];
  readonly workflowTool?: CompiledWorkflowToolDefinition;
  readonly dynamicInstructions?: readonly CompiledDynamicInstructionsDefinition[];
  readonly dynamicSkills?: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools?: readonly CompiledDynamicToolDefinition[];
  readonly hooks?: readonly CompiledHookDefinition[];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox?: CompiledSandboxDefinition | null;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly instructions?: CompiledInstructionsDefinition;
  readonly tools?: readonly CompiledToolDefinition[];
  readonly workspaceResourceRoot?: CompiledWorkspaceResourceRoot;
}): CompiledAgentNodeManifest {
  const node: CompiledAgentNodeManifest = {
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    channels: [...(input.channels ?? [])],
    connections: [...(input.connections ?? [])],
    config: {
      build:
        input.config.build === undefined
          ? undefined
          : {
              externalDependencies:
                input.config.build.externalDependencies === undefined
                  ? undefined
                  : [...input.config.build.externalDependencies],
            },
      compaction: {
        model:
          input.config.compaction?.model === undefined
            ? undefined
            : cloneCompiledRuntimeModelReference(input.config.compaction.model),
        thresholdPercent: input.config.compaction?.thresholdPercent,
      },
      description: input.config.description,
      dynamicModel:
        input.config.dynamicModel === undefined
          ? undefined
          : {
              ...input.config.dynamicModel,
            },
      experimental:
        input.config.experimental === undefined
          ? undefined
          : {
              workflow:
                input.config.experimental.workflow === undefined
                  ? undefined
                  : {
                      world: input.config.experimental.workflow.world,
                    },
            },
      model: cloneCompiledRuntimeModelReference(input.config.model),
      name: input.config.name,
      outputSchema: input.config.outputSchema,
      reasoning: input.config.reasoning,
      limits:
        input.config.limits === undefined
          ? undefined
          : {
              maxInputTokensPerSession: input.config.limits.maxInputTokensPerSession,
              maxOutputTokensPerSession: input.config.limits.maxOutputTokensPerSession,
            },
      source:
        input.config.source === undefined
          ? undefined
          : {
              ...input.config.source,
            },
    },
    diagnosticsSummary: input.diagnosticsSummary ?? {
      errors: 0,
      warnings: 0,
    },
    disabledFrameworkTools: [...(input.disabledFrameworkTools ?? [])],
    workflowTool:
      input.workflowTool === undefined
        ? undefined
        : { maxSubagents: input.workflowTool.maxSubagents },
    dynamicInstructions: [...(input.dynamicInstructions ?? [])],
    dynamicSkills: [...(input.dynamicSkills ?? [])],
    dynamicTools: [...(input.dynamicTools ?? [])],
    hooks: [...(input.hooks ?? [])],
    remoteAgents: [...(input.remoteAgents ?? [])],
    sandbox: input.sandbox ?? null,
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    schedules: [...(input.schedules ?? [])],
    skills: [...(input.skills ?? [])],
    tools: [...(input.tools ?? [])],
    workspaceResourceRoot: input.workspaceResourceRoot ?? {
      logicalPath: "",
      rootEntries: deriveResourceRootEntries({
        sandboxWorkspaces: input.sandboxWorkspaces,
        skills: input.skills,
      }),
    },
  };

  if (input.instructions !== undefined) {
    node.instructions = input.instructions;
  }

  return node;
}

/**
 * Computes the sorted `rootEntries` advertised by the workspace resource
 * tree for one graph node.
 *
 * Shared by the synthetic manifest factory (used in tests and the
 * in-memory compile path) and by `materializeWorkspaceResources` so both
 * paths emit identical descriptors.
 */
export function deriveResourceRootEntries(input: {
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly skills?: readonly CompiledSkillDefinition[];
}): readonly string[] {
  const rootEntries = new Set<string>();

  for (const workspace of input.sandboxWorkspaces ?? []) {
    for (const entry of workspace.rootEntries) {
      rootEntries.add(entry);
    }
  }

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
export function createCompiledAgentManifest(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly channels?: readonly CompiledChannelEntry[];
  readonly config: CompiledAgentDefinition;
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly diagnosticsSummary?: DiscoverDiagnosticsSummary;
  readonly disabledFrameworkTools?: readonly string[];
  readonly workflowTool?: CompiledWorkflowToolDefinition;
  readonly dynamicSkills?: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools?: readonly CompiledDynamicToolDefinition[];
  readonly hooks?: readonly CompiledHookDefinition[];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox?: CompiledSandboxDefinition | null;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly subagentEdges?: readonly CompiledSubagentEdge[];
  readonly subagents?: readonly CompiledSubagentNode[];
  readonly instructions?: CompiledInstructionsDefinition;
  readonly tools?: readonly CompiledToolDefinition[];
  readonly extensionMounts?: readonly CompiledExtensionMount[];
}): CompiledAgentManifest {
  return {
    ...createCompiledAgentNodeManifest(input),
    kind: COMPILED_AGENT_MANIFEST_KIND,
    extensionMounts: [...(input.extensionMounts ?? [])],
    subagentEdges: [...(input.subagentEdges ?? [])],
    subagents: [...(input.subagents ?? [])],
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };
}

function cloneCompiledRuntimeModelReference(
  model: CompiledRuntimeModelReference,
): CompiledRuntimeModelReference {
  const clone: CompiledRuntimeModelReference = {
    id: model.id,
    routing: cloneModelRouting(model.routing),
  };
  if (model.contextWindowTokens !== undefined) {
    clone.contextWindowTokens = model.contextWindowTokens;
  }
  if (model.providerOptions !== undefined) {
    clone.providerOptions = { ...model.providerOptions };
  }
  if (model.source !== undefined) {
    clone.source = { ...model.source };
  }
  return clone;
}

function cloneModelRouting(routing: ModelRouting): ModelRouting {
  if (routing.kind === "external") {
    return { kind: "external", provider: routing.provider };
  }
  return routing.byok === undefined
    ? { kind: "gateway", target: routing.target }
    : { kind: "gateway", target: routing.target, byok: routing.byok };
}
