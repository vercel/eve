/**
 * Zod schemas for the compiled agent manifest. They live apart from `manifest.ts`, whose constants
 * and types the runtime imports everywhere, so a deployed agent builds them only when it reads a
 * manifest from disk. Hosted builds check the bundled manifest against them at build time.
 */
import { z } from "#compiled/zod/index.js";
import { mountIdSchema } from "#shared/extension-mount.js";
import { discoverDiagnosticsSummarySchema } from "#discover/diagnostics.js";
import { compiledRemoteAgentNodeSchema } from "#compiler/remote-agent-node.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import { jsonObjectSchema } from "#shared/json-schemas.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { WEB_SEARCH_FALLBACK_PROVIDERS, WEB_SEARCH_PROVIDERS } from "#shared/web-search.js";
import {
  AGENT_WORKFLOW_RETENTION_VALUES,
  ANTHROPIC_PROMPT_CACHE_TTLS,
  type ModelRouting,
} from "#shared/agent-definition.js";
import type { VercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";
import type {
  AgentModuleBacking,
  AgentSourceComposition,
  AgentSourceDescriptor,
  AgentSourceOwner,
  CompiledModuleBinding,
} from "#compiler/source-graph.js";
import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  type CompiledChannelPreflightDefinition,
  type CompiledShadowedChannelRoute,
  type CompiledChannelRoutePlan,
  type CompiledRuntimeModelReference,
  type CompiledDynamicModelDefinition,
  type CompiledAgentDefinition,
  type CompiledInstructionsDefinition,
  type CompiledSkillDefinition,
  type CompiledDefinition,
  type CompiledSubagentNode,
  type CompiledExtensionMount,
  type CompiledAgentBuildDefinition,
  type CompiledAgentCompactionDefinition,
} from "#compiler/manifest.js";
export const agentSourceOwnerSchema: z.ZodType<AgentSourceOwner> = z.discriminatedUnion("kind", [
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

export const moduleSourceRefSchema: z.ZodType<ModuleSourceRef> = z
  .object({
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

export const filesystemModuleBackingSchema = z
  .object({
    externalDependencies: z.array(z.string()).readonly(),
    extensionScope: z.object({ namespace: z.string(), sourceRoot: z.string() }).strict().optional(),
    mountId: z.string().optional(),
    kind: z.literal("filesystem"),
    sourcePath: z.string(),
  })
  .strict();

export const programmaticModuleBackingSchema = z
  .object({
    kind: z.literal("programmatic"),
    mountId: z.string().optional(),
    moduleId: z.string(),
    registryId: z.string(),
    revision: z.string(),
    semanticRevision: z.string().optional(),
  })
  .strict();

export const resourceSourceBackingSchema = z
  .object({ kind: z.literal("resource"), sourcePath: z.string() })
  .strict();

export const agentModuleBackingSchema: z.ZodType<AgentModuleBacking> = z.discriminatedUnion(
  "kind",
  [filesystemModuleBackingSchema, programmaticModuleBackingSchema],
);

export const compiledModuleBindingSchema: z.ZodType<CompiledModuleBinding> = z
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

export const agentSourceDescriptorSchema: z.ZodType<AgentSourceDescriptor> = z
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

export const agentSourceCompositionSchema: z.ZodType<AgentSourceComposition> = z
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

export const compiledDynamicModelDefinitionSchema: z.ZodType<CompiledDynamicModelDefinition> = z
  .object({
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

export const channelMethodSchema = z.union([
  z.literal("GET"),
  z.literal("HEAD"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
  z.literal("OPTIONS"),
  z.literal("WEBSOCKET"),
]);

export const compiledChannelCorsSchema = z
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

export const compiledVercelConnectMetadataSchema = z
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

export const compiledChannelDefinitionSchema = z
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

export const compiledChannelPreflightDefinitionSchema: z.ZodType<CompiledChannelPreflightDefinition> =
  z
    .object({
      cors: compiledChannelCorsSchema,
      method: z.literal("OPTIONS"),
      sourceIds: z.array(z.string()).readonly(),
      urlPath: z.string(),
    })
    .strict();

export const compiledShadowedChannelRouteSchema: z.ZodType<CompiledShadowedChannelRoute> = z
  .object({
    method: channelMethodSchema,
    source: agentSourceDescriptorSchema,
    urlPath: z.string(),
    winnerSourceId: z.string(),
  })
  .strict();

export const compiledChannelRoutePlanSchema: z.ZodType<CompiledChannelRoutePlan> = z
  .object({
    effective: z.array(compiledChannelDefinitionSchema).readonly(),
    preflight: z.array(compiledChannelPreflightDefinitionSchema).readonly(),
    shadowed: z.array(compiledShadowedChannelRouteSchema).readonly(),
  })
  .strict();

export const modelRoutingSchema = z.union([
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

export const compiledRuntimeModelReferenceSchema: z.ZodType<CompiledRuntimeModelReference> = z
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

export const compiledAgentBuildDefinitionSchema: z.ZodType<CompiledAgentBuildDefinition> = z
  .object({
    externalDependencies: z.array(z.string()).optional(),
  })
  .strict();

export const compiledAgentWorkflowWorldDefinitionSchema = z.string();

export const compiledAgentWorkflowDefinitionSchema = z
  .object({
    modelCallsPerStep: z.number().int().positive().optional(),
    retention: z.literal(AGENT_WORKFLOW_RETENTION_VALUES).optional(),
    world: compiledAgentWorkflowWorldDefinitionSchema.optional(),
  })
  .strict();

export const compiledAgentCompactionDefinitionSchema: z.ZodType<CompiledAgentCompactionDefinition> =
  z
    .object({
      model: compiledRuntimeModelReferenceSchema.optional(),
      thresholdPercent: z.number().finite().min(0).max(1).optional(),
    })
    .strict();

export const sessionTimeoutSchema = z.union([z.number().int().positive(), z.literal(false)]);

export const compiledAgentLimitsDefinitionSchema = z
  .object({
    sessionTimeoutMs: sessionTimeoutSchema.optional(),
    sessionUsage: z.boolean().optional(),
  })
  .strict();

export const compiledAgentConfigBaseFields = {
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

export const compiledAgentConfigSchema: z.ZodType<CompiledAgentDefinition> = z.union([
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

export const compiledInstructionsBaseFields = {
  content: z.string(),
  name: z.string(),
  logicalPath: z.string(),
  role: z.enum(["system", "user"]),
  sourceId: z.string(),
};

export const compiledInstructionsSchema: z.ZodType<CompiledInstructionsDefinition> =
  z.discriminatedUnion("sourceKind", [
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
  ]);

export const compiledSkillBaseFields = {
  name: z.string(),
  deferred: z.boolean().optional(),
  description: z.string(),
  license: z.string().optional(),
  content: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  sourceId: z.string(),
  logicalPath: z.string(),
};

export const compiledSkillSourceSchema: z.ZodType<CompiledSkillDefinition> = z.discriminatedUnion(
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

export const compiledScheduleBaseFields = {
  cron: z.string(),
  hasRun: z.boolean(),
  name: z.string(),
  logicalPath: z.string(),
  markdown: z.string().optional(),
  sourceId: z.string(),
};

export const compiledScheduleDefinitionSchema = z.discriminatedUnion("sourceKind", [
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

export const compiledScheduleCollectionDefinitionSchema = z
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

export const compiledSandboxDefinitionSchema = z
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

export const compiledSandboxWorkspaceSchema = z
  .object({
    logicalPath: z.string(),
    rootEntries: z.array(z.string()).readonly(),
    sourceId: z.string(),
    sourcePath: z.string(),
  })
  .strict();

export const compiledWorkspaceResourceRootSchema = z
  .object({
    contentHash: z.string().optional(),
    logicalPath: z.string(),
    rootEntries: z.array(z.string()).readonly(),
  })
  .strict();

export const compiledConnectionDefinitionSchema = z
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

export const compiledToolBehaviorSchema: z.ZodType<CompiledToolBehavior> = z
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

export const compiledToolDefinitionSchema = z
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

export const compiledDefinitionSchema: z.ZodType<CompiledDefinition> = z
  .object({
    description: z.string().optional(),
    eventNames: z.array(z.string()).readonly().optional(),
    exportName: z.string().optional(),
    extensionNamespace: z.string().optional(),
    kind: z.enum(["connection", "hook", "instructions", "memory", "renderer", "skill", "tool"]),
    logicalPath: z.string(),
    mediaType: z.string().optional(),
    slug: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

export const compiledExtensionMountSchema: z.ZodType<CompiledExtensionMount> = z
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
export const compiledAgentResourceFields = {
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

export const compiledAgentResourcesSchema = z.object(compiledAgentResourceFields).strict();

export const compiledAgentNodeManifestSchema = z
  .object({
    ...compiledAgentResourceFields,
    config: compiledAgentConfigSchema,
  })
  .strict();

export const compiledSubagentNodeBaseFields = {
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
export const compiledDynamicSubagentDefinitionSchema = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();
export const compiledSubagentNodeSchema: z.ZodType<CompiledSubagentNode> = z.union([
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
