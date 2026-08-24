import { z } from "#compiled/zod/index.js";

import {
  type CompilerDiagnosticsSummary,
  compilerDiagnosticsSummarySchema,
} from "#shared/compiler-diagnostics.js";
import {
  type CompiledDynamicSubagentDefinition,
  compiledRemoteAgentNodeSchema,
  type CompiledRemoteAgentNode,
} from "#compiler/remote-agent-node.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  type NormalizedChannelCorsOptions,
  validateNormalizedChannelCorsOptions,
} from "#channel/cors.js";
import { CHANNEL_ROUTE_METHODS } from "#channel/routes.js";
import type { InternalInstructionsDefinition } from "#shared/instructions-definition.js";
import { jsonObjectSchema } from "#shared/json-schemas.js";
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
  AgentExperimentalDefinition,
  ModelRouting,
} from "#shared/agent-definition.js";
import type { InternalToolDefinition } from "#shared/tool-definition.js";
import type { WebSearchProvider } from "#shared/web-search.js";
import { workspaceResourceLogicalPath } from "#shared/workspace-resource-identity.js";
import { KERNEL_CAPABILITY_NAMES, type KernelCapabilityPlan } from "#kernel/capabilities.js";
import {
  assertKernelPlanSemantics,
  collectCompiledManifestKernelSemanticIssues,
  type KernelSemanticSubagentSource,
} from "#compiler/kernel-plan-semantics.js";
import {
  assertCompiledAgentManifestSemantics,
  assertTotalModuleBindings,
  compiledModuleBindingSchema,
  type CompiledModuleBinding,
} from "#compiler/module-binding.js";
import {
  compiledExternalDependencyPlanSchema,
  type CompiledExternalDependencyPlan,
} from "#compiler/external-dependency-plan.js";
import {
  agentSourceCompositionSchema,
  type AgentSourceComposition,
  type CompiledSubagentSource,
  compiledSubagentSourceSchema,
} from "#compiler/source-composition.js";
import {
  assertValidCompiledChannelRoutePlan,
  validateCompiledChannelRoutePlan,
} from "#compiler/channel-route-plan.js";
import {
  assertValidCompiledWorkflowWorldPlan,
  compiledWorkflowWorldPlanSchema,
  type CompiledWorkflowWorldPlan,
} from "#compiler/workflow-world-plan.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import { assertCompiledNodeScopeSemantics } from "#compiler/compiled-agent-graph-semantics.js";
import {
  assertWorkspaceResourceRootSemantics,
  collectCompiledSandboxInheritanceSemanticIssues,
  deriveResourceRootEntries,
} from "#compiler/workspace-resource-semantics.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export {
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/compiled-agent-node-id.js";

/**
 * Stable manifest kind emitted by the compiler for runtime loading.
 */
export const COMPILED_AGENT_MANIFEST_KIND = "eve-agent-compiled-manifest";

/**
 * Current compiled manifest schema version.
 */
export const COMPILED_AGENT_MANIFEST_VERSION = 59;

export { deriveResourceRootEntries } from "#compiler/workspace-resource-semantics.js";

/**
 * Active compiled channel entry backed by the selected `Channel` source.
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

/** Derived CORS preflight selected after ordinary route winners. */
export interface CompiledChannelPreflightDefinition {
  readonly cors: NormalizedChannelCorsOptions;
  readonly pathPattern: string;
  readonly sourceIds: readonly string[];
}

/** One losing concrete route retained with complete source provenance. */
export interface CompiledShadowedChannelRoute {
  readonly loser: {
    readonly binding: CompiledModuleBinding;
    readonly route: CompiledChannelDefinition;
  };
  readonly method: ChannelRouteMethod;
  readonly pathPattern: string;
  readonly winningSourceId: string;
}

/** Compiler-owned effective ordinary route plan consumed downstream. */
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
export type CompiledAgentExperimentalDefinition = Omit<AgentExperimentalDefinition, "workflow"> & {
  readonly workflow?: never;
};

type CompiledAgentDefinitionBase = Omit<
  InternalAgentDefinition,
  "model" | "compaction" | "experimental" | "source"
> & {
  compaction?: CompiledAgentCompactionDefinition;
  experimental?: CompiledAgentExperimentalDefinition;
  readonly source: ModuleSourceRef;
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
  (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef);

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
export type CompiledToolDefinition = InternalToolDefinition &
  ModuleSourceRef & {
    readonly hasAuth: boolean;
    readonly hasExecute: boolean;
    readonly hasModelOutputProjection: boolean;
    readonly requiresApproval: boolean;
  };

/**
 * Serializable configuration for the experimental framework `Workflow` tool.
 */
export interface CompiledWorkflowToolDefinition extends ModuleSourceRef {
  readonly maxSubagents?: number;
}

/**
 * Serializable configuration for the provider-managed web search tool.
 */
export interface CompiledWebSearchProviderDefinition extends ModuleSourceRef {
  readonly provider: WebSearchProvider;
}

export type CompiledInstrumentationActivation = "always" | "development" | "production";

export type CompiledInstrumentationPlan =
  | { readonly kind: "none" }
  | {
      readonly entry: {
        readonly activation: CompiledInstrumentationActivation;
        readonly implementation: "config" | "local-tracing";
        readonly source: ModuleSourceRef;
      };
      readonly kind: "file";
    }
  | {
      readonly entries: readonly {
        readonly activation: CompiledInstrumentationActivation;
        readonly implementation: "provider";
        readonly slot: string;
        readonly source: ModuleSourceRef;
      }[];
      readonly kind: "providers";
    };

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
 * role-aware instructions at runtime.
 */
export interface CompiledDynamicInstructionsDefinition extends ModuleSourceRef {
  readonly slug: string;
  readonly eventNames: readonly string[];
}

/**
 * Normalized authored hook entry preserved in the compiled manifest.
 *
 * Event names and callable handler shape are captured during compilation.
 * Handler implementations remain in the module map and are resolved at runtime.
 */
export interface CompiledHookDefinition extends ModuleSourceRef {
  readonly eventNames: readonly string[];
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

export type CompiledAgentResources = z.infer<typeof compiledAgentResourcesSchema>;

export type CompiledSubagentNode = Readonly<
  CompiledSubagentSource &
    (
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

const compiledInstrumentationActivationSchema = z.enum(["always", "development", "production"]);

const compiledInstrumentationPlanSchema: z.ZodType<CompiledInstrumentationPlan> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        entry: z
          .object({
            activation: compiledInstrumentationActivationSchema,
            implementation: z.enum(["config", "local-tracing"]),
            source: moduleSourceRefSchema,
          })
          .strict(),
        kind: z.literal("file"),
      })
      .strict(),
    z
      .object({
        entries: z
          .array(
            z
              .object({
                activation: compiledInstrumentationActivationSchema,
                implementation: z.literal("provider"),
                slot: z.string().min(1),
                source: moduleSourceRefSchema,
              })
              .strict(),
          )
          .readonly(),
        kind: z.literal("providers"),
      })
      .strict(),
  ]);

const compiledDynamicModelDefinitionSchema: z.ZodType<CompiledDynamicModelDefinition> = z
  .object({
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
    logicalPath: z.string(),
    sourceId: z.string(),
  })
  .strict();

const channelMethodSchema = z.enum(CHANNEL_ROUTE_METHODS);

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
  .strict()
  .superRefine((cors, context) => {
    for (const issue of validateNormalizedChannelCorsOptions(cors)) {
      context.addIssue({ code: "custom", message: issue });
    }
  }) satisfies z.ZodType<NormalizedChannelCorsOptions>;

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

const compiledChannelPreflightDefinitionSchema: z.ZodType<CompiledChannelPreflightDefinition> = z
  .object({
    cors: compiledChannelCorsSchema,
    pathPattern: z.string(),
    sourceIds: z.array(z.string()).readonly(),
  })
  .strict();

const compiledShadowedChannelRouteSchema: z.ZodType<CompiledShadowedChannelRoute> = z
  .object({
    loser: z
      .object({
        binding: compiledModuleBindingSchema,
        route: compiledChannelDefinitionSchema,
      })
      .strict(),
    method: channelMethodSchema,
    pathPattern: z.string(),
    winningSourceId: z.string(),
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
    maxOutputTokens: z.number().int().positive().optional(),
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

const compiledAgentCompactionDefinitionSchema: z.ZodType<CompiledAgentCompactionDefinition> = z
  .object({
    model: compiledRuntimeModelReferenceSchema.optional(),
    thresholdPercent: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const sessionTokenLimitSchema = z.union([z.number().int().positive(), z.literal(false)]);
const sessionTimeoutSchema = z.union([z.number().int().positive(), z.literal(false)]);

const compiledAgentLimitsDefinitionSchema = z
  .object({
    maxInputTokensPerSession: sessionTokenLimitSchema.optional(),
    maxOutputTokensPerSession: sessionTokenLimitSchema.optional(),
    sessionTimeoutMs: sessionTimeoutSchema.optional(),
  })
  .strict();

const compiledWorkflowToolDefinitionSchema: z.ZodType<CompiledWorkflowToolDefinition> = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    maxSubagents: z.number().int().positive().optional(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledWebSearchProviderDefinitionSchema: z.ZodType<CompiledWebSearchProviderDefinition> = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    provider: z.enum(["exa", "parallel"]),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledAgentConfigBaseFields = {
  build: compiledAgentBuildDefinitionSchema.optional(),
  compaction: compiledAgentCompactionDefinitionSchema.optional(),
  description: z.string().optional(),
  experimental: z
    .object({
      instrumentationProviders: z.boolean().optional(),
      subagentPersistentSessions: z.boolean().optional(),
      tasks: z.boolean().optional(),
    })
    .strict()
    .optional(),
  name: z.string(),
  outputSchema: jsonObjectSchema.optional(),
  reasoning: z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  source: moduleSourceRefSchema,
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
        sourceKind: z.literal("markdown"),
      })
      .strict(),
    z
      .object({
        ...compiledInstructionsBaseFields,
        exportName: z.string().optional(),
        sourceKind: z.literal("module"),
      })
      .strict(),
  ],
);

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
      sourceKind: z.literal("markdown"),
    })
    .strict(),
  z
    .object({
      ...compiledScheduleBaseFields,
      exportName: z.string().optional(),
      sourceKind: z.literal("module"),
    })
    .strict(),
]);

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
    hasBootstrap: z.boolean(),
    hasOnSession: z.boolean(),
    inheritsParent: z.boolean().optional(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    revalidationKey: z.string().optional(),
    sourceHash: z.string().regex(SHA256_PATTERN),
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
    contentHash: z.string().regex(SHA256_PATTERN).optional(),
    logicalPath: z.string(),
    rootEntries: z.array(z.string()).readonly(),
  })
  .strict();

const compiledConnectionDefinitionSchema = z
  .object({
    connectionName: z.string(),
    description: z.string(),
    hasApproval: z.boolean(),
    hasAuthorization: z.boolean(),
    hasHeaders: z.boolean(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    /** Wire protocol the connection speaks. */
    protocol: z.enum(["mcp", "openapi"]),
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
    execution: z.literal("background").optional(),
    exportName: z.string().optional(),
    hasAuth: z.boolean(),
    hasExecute: z.boolean(),
    hasModelOutputProjection: z.boolean(),
    inputSchema: jsonObjectSchema.nullable(),
    logicalPath: z.string(),
    name: z.string(),
    outputSchema: jsonObjectSchema.optional(),
    requiresApproval: z.boolean(),
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
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
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
    packageNamespace: z.string(),
    sourceRoot: z.string(),
    mountSourceId: z.string(),
    mountLogicalPath: z.string(),
  })
  .strict();

const kernelCapabilityPlanSchema: z.ZodType<KernelCapabilityPlan> = z
  .object({
    prepared: z.array(z.enum(KERNEL_CAPABILITY_NAMES)).readonly(),
  })
  .strict()
  .superRefine((plan, context) => {
    const indexes = plan.prepared.map((name) => KERNEL_CAPABILITY_NAMES.indexOf(name));
    if (
      new Set(plan.prepared).size !== plan.prepared.length ||
      indexes.some((index, position) => position > 0 && index <= indexes[position - 1]!)
    ) {
      context.addIssue({
        code: "custom",
        message: "Kernel capability plans must be unique and follow inventory order.",
        path: ["prepared"],
      });
    }
  });

/**
 * Zod schema for one non-recursive compiled authored agent payload.
 */
const compiledAgentResourceFields = {
  agentRoot: z.string(),
  appRoot: z.string(),
  bindings: z.record(z.string(), compiledModuleBindingSchema).readonly(),
  sourceComposition: agentSourceCompositionSchema,
  channelRoutes: compiledChannelRoutePlanSchema,
  connections: z.array(compiledConnectionDefinitionSchema),
  diagnosticsSummary: compilerDiagnosticsSummarySchema,
  kernelPlan: kernelCapabilityPlanSchema,
  workflowTool: compiledWorkflowToolDefinitionSchema.optional(),
  webSearchProvider: compiledWebSearchProviderDefinitionSchema.optional(),
  dynamicInstructions: z.array(compiledDynamicInstructionsDefinitionSchema),
  dynamicSkills: z.array(compiledDynamicSkillDefinitionSchema),
  dynamicTools: z.array(compiledDynamicToolDefinitionSchema),
  extensionMounts: z.array(compiledExtensionMountSchema),
  hooks: z.array(compiledHookDefinitionSchema),
  instrumentation: compiledInstrumentationPlanSchema,
  sandbox: compiledSandboxDefinitionSchema,
  sandboxWorkspaces: z.array(compiledSandboxWorkspaceSchema),
  schedules: z.array(compiledScheduleDefinitionSchema),
  remoteAgents: z.array(compiledRemoteAgentNodeSchema),
  skills: z.array(compiledSkillSourceSchema).readonly(),
  instructions: z.array(compiledInstructionsSchema).readonly(),
  tools: z.array(compiledToolDefinitionSchema),
  workspaceResourceRoot: compiledWorkspaceResourceRootSchema,
};

const compiledAgentResourcesSchema = z
  .object(compiledAgentResourceFields)
  .strict()
  .superRefine(validateCompiledChildResourceRelationships);

const compiledAgentNodeManifestSchema = z
  .object({
    ...compiledAgentResourceFields,
    config: compiledAgentConfigSchema,
  })
  .strict()
  .superRefine(validateCompiledChildResourceRelationships);

const compiledSubagentNodeBaseFields = {
  ...compiledSubagentSourceSchema.shape,
};
const compiledDynamicSubagentDefinitionSchema = z
  .object({
    build: compiledAgentBuildDefinitionSchema.optional(),
    eventNames: z.array(z.string()).readonly(),
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

const compiledSubagentEdgeSchema: z.ZodType<CompiledSubagentEdge> = z
  .object({
    childNodeId: z.string(),
    parentNodeId: z.string(),
  })
  .strict();

/**
 * One mounted extension recorded on a compiled agent manifest. The runtime
 * evaluates {@link mountLogicalPath} at module-map load so the mount's factory
 * call binds the extension's config before any tool runs.
 */
export interface CompiledExtensionMount {
  /** Runtime packages this extension requires the consuming application to externalize. */
  readonly externalDependencies: readonly string[];
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

/**
 * Zod schema for the versioned compiled manifest emitted by the compiler.
 */
export const compiledAgentManifestSchema = z
  .object({
    agentRoot: z.string(),
    appRoot: z.string(),
    bindings: z.record(z.string(), compiledModuleBindingSchema).readonly(),
    sourceComposition: agentSourceCompositionSchema,
    extensionMounts: z.array(compiledExtensionMountSchema),
    channelRoutes: compiledChannelRoutePlanSchema,
    config: compiledAgentConfigSchema,
    connections: z.array(compiledConnectionDefinitionSchema),
    diagnosticsSummary: compilerDiagnosticsSummarySchema,
    externalDependencyPlan: compiledExternalDependencyPlanSchema,
    kernelPlan: kernelCapabilityPlanSchema,
    workflowTool: compiledWorkflowToolDefinitionSchema.optional(),
    webSearchProvider: compiledWebSearchProviderDefinitionSchema.optional(),
    dynamicInstructions: z.array(compiledDynamicInstructionsDefinitionSchema),
    dynamicSkills: z.array(compiledDynamicSkillDefinitionSchema),
    dynamicTools: z.array(compiledDynamicToolDefinitionSchema),
    hooks: z.array(compiledHookDefinitionSchema),
    instrumentation: compiledInstrumentationPlanSchema,
    kind: z.literal(COMPILED_AGENT_MANIFEST_KIND),
    remoteAgents: z.array(compiledRemoteAgentNodeSchema),
    sandbox: compiledSandboxDefinitionSchema,
    sandboxWorkspaces: z.array(compiledSandboxWorkspaceSchema),
    schedules: z.array(compiledScheduleDefinitionSchema),
    skills: z.array(compiledSkillSourceSchema).readonly(),
    subagentEdges: z.array(compiledSubagentEdgeSchema),
    subagents: z.array(compiledSubagentNodeSchema),
    instructions: z.array(compiledInstructionsSchema).readonly(),
    tools: z.array(compiledToolDefinitionSchema),
    workflowWorld: compiledWorkflowWorldPlanSchema,
    version: z.literal(COMPILED_AGENT_MANIFEST_VERSION),
    workspaceResourceRoot: compiledWorkspaceResourceRootSchema,
  })
  .strict()
  .superRefine(validateCompiledRootManifestRelationships);

function validateCompiledChildResourceRelationships(
  resources: CompiledAgentResources | CompiledAgentNodeManifest,
  context: z.RefinementCtx,
): void {
  for (const issue of validateCompiledChannelRoutePlan(
    resources.channelRoutes,
    resources.bindings,
  )) {
    context.addIssue({ code: "custom", message: issue, path: ["channelRoutes"] });
  }
}

function validateCompiledRootManifestRelationships(
  manifest: CompiledAgentManifest,
  context: z.RefinementCtx,
): void {
  for (const issue of validateCompiledChannelRoutePlan(manifest.channelRoutes, manifest.bindings)) {
    context.addIssue({ code: "custom", message: issue, path: ["channelRoutes"] });
  }
  for (const issue of collectCompiledManifestKernelSemanticIssues(manifest)) {
    context.addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
  }
  for (const issue of collectCompiledSandboxInheritanceSemanticIssues(manifest)) {
    context.addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
  }
}

export interface CreateCompiledAgentResourcesInput {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly sourceComposition: AgentSourceComposition;
  readonly channelRoutes: CompiledChannelRoutePlan;
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly diagnosticsSummary?: CompilerDiagnosticsSummary;
  readonly kernelPlan: KernelCapabilityPlan;
  readonly workflowTool?: CompiledWorkflowToolDefinition;
  readonly webSearchProvider?: CompiledWebSearchProviderDefinition;
  readonly dynamicInstructions?: readonly CompiledDynamicInstructionsDefinition[];
  readonly dynamicSkills?: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools?: readonly CompiledDynamicToolDefinition[];
  readonly extensionMounts?: readonly CompiledExtensionMount[];
  readonly hooks?: readonly CompiledHookDefinition[];
  readonly instrumentation: CompiledInstrumentationPlan;
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox: CompiledSandboxDefinition;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly instructions?: readonly CompiledInstructionsDefinition[];
  readonly tools?: readonly CompiledToolDefinition[];
  readonly workspaceResourceRoot?: CompiledWorkspaceResourceRoot;
}

export interface CreateCompiledAgentResourcesOptions {
  /** Module references stored on a graph edge but bound by these resources. */
  readonly additionalBindingReferences?: readonly ModuleSourceRef[];
  /** Stable node id used in semantic validation diagnostics. */
  readonly nodeId: string;
  readonly isRoot: boolean;
  readonly subagentSources?: readonly KernelSemanticSubagentSource[];
  readonly tasksEnabled?: boolean;
}

/** Creates compiled filesystem-owned resources with stable defaults. */
export function createCompiledAgentResources(
  input: CreateCompiledAgentResourcesInput,
  options: CreateCompiledAgentResourcesOptions,
): CompiledAgentResources {
  const resources = createCompiledAgentResourceFields(input, options.nodeId);
  const nodeId = options.nodeId;
  assertCompiledNodeScopeSemantics(resources, {
    isRoot: options.isRoot === true,
    nodeId,
  });
  assertWorkspaceResourceRootSemantics(resources, {
    nodeId,
    requireContentHash: false,
  });
  assertValidCompiledChannelRoutePlan({
    bindings: resources.bindings,
    nodeId,
    plan: resources.channelRoutes,
  });
  assertTotalModuleBindings({
    additionalRefs: options.additionalBindingReferences,
    bindings: resources.bindings,
    manifest: resources,
    nodeId,
  });
  assertKernelPlanSemantics(resources, {
    isRoot: options.isRoot === true,
    nodeId,
    subagentSources: options.subagentSources,
    tasksEnabled: options.tasksEnabled,
  });
  return resources;
}

function createCompiledAgentResourceFields(
  input: CreateCompiledAgentResourcesInput,
  nodeId: string,
): CompiledAgentResources {
  return {
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    bindings: { ...input.bindings },
    sourceComposition: {
      disabled: [...input.sourceComposition.disabled],
      selected: [...input.sourceComposition.selected],
      shadowed: [...input.sourceComposition.shadowed],
    },
    channelRoutes: cloneCompiledChannelRoutePlan(input.channelRoutes),
    connections: [...(input.connections ?? [])],
    diagnosticsSummary: input.diagnosticsSummary ?? {
      errors: 0,
      warnings: 0,
    },
    kernelPlan: { prepared: [...input.kernelPlan.prepared] },
    workflowTool: input.workflowTool === undefined ? undefined : { ...input.workflowTool },
    webSearchProvider:
      input.webSearchProvider === undefined ? undefined : { ...input.webSearchProvider },
    dynamicInstructions: [...(input.dynamicInstructions ?? [])],
    dynamicSkills: [...(input.dynamicSkills ?? [])],
    dynamicTools: [...(input.dynamicTools ?? [])],
    extensionMounts: [...(input.extensionMounts ?? [])],
    hooks: input.hooks?.map((hook) => ({ ...hook, eventNames: [...hook.eventNames] })) ?? [],
    instrumentation: cloneCompiledInstrumentationPlan(input.instrumentation),
    instructions: [...(input.instructions ?? [])],
    remoteAgents: [...(input.remoteAgents ?? [])],
    sandbox: { ...input.sandbox },
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    schedules: [...(input.schedules ?? [])],
    skills: [...(input.skills ?? [])],
    tools: [...(input.tools ?? [])],
    workspaceResourceRoot: input.workspaceResourceRoot ?? {
      logicalPath: workspaceResourceLogicalPath(nodeId),
      rootEntries: deriveResourceRootEntries({
        sandboxWorkspaces: input.sandboxWorkspaces,
      }),
    },
  };
}

function cloneCompiledInstrumentationPlan(
  plan: CompiledInstrumentationPlan,
): CompiledInstrumentationPlan {
  if (plan.kind === "none") return { kind: "none" };
  if (plan.kind === "file") {
    return {
      entry: { ...plan.entry, source: { ...plan.entry.source } },
      kind: "file",
    };
  }
  return {
    entries: plan.entries.map((entry) => ({ ...entry, source: { ...entry.source } })),
    kind: "providers",
  };
}

function cloneCompiledChannelRoutePlan(plan: CompiledChannelRoutePlan): CompiledChannelRoutePlan {
  return {
    effective: plan.effective.map((route) => ({ ...route })),
    preflight: plan.preflight.map((preflight) => ({
      ...preflight,
      sourceIds: [...preflight.sourceIds],
    })),
    shadowed: plan.shadowed.map((shadowed) => ({
      ...shadowed,
      loser: {
        binding: { ...shadowed.loser.binding },
        route: { ...shadowed.loser.route },
      },
    })),
  };
}

export type CreateCompiledAgentNodeManifestInput = CreateCompiledAgentResourcesInput & {
  readonly config: CompiledAgentDefinition;
};

/** Creates a compiled authored agent payload with stable defaults. */
export function createCompiledAgentNodeManifest(
  input: CreateCompiledAgentNodeManifestInput,
  options: Pick<CreateCompiledAgentResourcesOptions, "isRoot" | "nodeId" | "subagentSources">,
): CompiledAgentNodeManifest {
  const manifest = createCompiledAgentNodeFields(input, options.nodeId);
  const nodeId = options.nodeId;
  assertCompiledNodeScopeSemantics(manifest, {
    isRoot: options.isRoot === true,
    nodeId,
  });
  assertWorkspaceResourceRootSemantics(manifest, {
    nodeId,
    requireContentHash: false,
  });
  assertValidCompiledChannelRoutePlan({
    bindings: manifest.bindings,
    nodeId,
    plan: manifest.channelRoutes,
  });
  assertTotalModuleBindings({
    bindings: manifest.bindings,
    manifest,
    nodeId,
  });
  assertKernelPlanSemantics(manifest, {
    isRoot: options.isRoot === true,
    nodeId,
    subagentSources: options.subagentSources,
    tasksEnabled: manifest.config.experimental?.tasks === true,
  });
  return manifest;
}

function createCompiledAgentNodeFields(
  input: CreateCompiledAgentNodeManifestInput,
  nodeId: string,
): CompiledAgentNodeManifest {
  return {
    ...createCompiledAgentResourceFields(input, nodeId),
    config: cloneCompiledAgentDefinition(input.config),
  };
}

function cloneCompiledAgentDefinition(config: CompiledAgentDefinition): CompiledAgentDefinition {
  const base = {
    build:
      config.build === undefined
        ? undefined
        : {
            externalDependencies:
              config.build.externalDependencies === undefined
                ? undefined
                : [...config.build.externalDependencies],
          },
    compaction: {
      model:
        config.compaction?.model === undefined
          ? undefined
          : cloneCompiledRuntimeModelReference(config.compaction.model),
      thresholdPercent: config.compaction?.thresholdPercent,
    },
    description: config.description,
    experimental:
      config.experimental === undefined
        ? undefined
        : {
            instrumentationProviders: config.experimental.instrumentationProviders,
            subagentPersistentSessions: config.experimental.subagentPersistentSessions,
            tasks: config.experimental.tasks,
          },
    name: config.name,
    outputSchema: config.outputSchema,
    reasoning: config.reasoning,
    limits:
      config.limits === undefined
        ? undefined
        : {
            maxInputTokensPerSession: config.limits.maxInputTokensPerSession,
            maxOutputTokensPerSession: config.limits.maxOutputTokensPerSession,
            sessionTimeoutMs: config.limits.sessionTimeoutMs,
          },
    source: { ...config.source },
  };

  if (config.dynamicModel !== undefined) {
    return {
      ...base,
      dynamicModel: { ...config.dynamicModel },
    };
  }

  return {
    ...base,
    model: cloneCompiledRuntimeModelReference(config.model),
  };
}

export interface CreateCompiledAgentManifestInput extends CreateCompiledAgentResourcesInput {
  readonly config: CompiledAgentDefinition;
  readonly externalDependencyPlan: CompiledExternalDependencyPlan;
  readonly subagentEdges?: readonly CompiledSubagentEdge[];
  readonly subagents?: readonly CompiledSubagentNode[];
  readonly workflowWorld: CompiledWorkflowWorldPlan;
}

/**
 * Creates a compiled manifest with stable defaults.
 */
export function createCompiledAgentManifest(
  input: CreateCompiledAgentManifestInput,
): CompiledAgentManifest {
  assertValidCompiledWorkflowWorldPlan(input.workflowWorld);
  const manifest: CompiledAgentManifest = {
    ...createCompiledAgentNodeFields(input, ROOT_COMPILED_AGENT_NODE_ID),
    externalDependencyPlan: cloneCompiledExternalDependencyPlan(input.externalDependencyPlan),
    kind: COMPILED_AGENT_MANIFEST_KIND,
    extensionMounts: [...(input.extensionMounts ?? [])],
    subagentEdges: [...(input.subagentEdges ?? [])],
    subagents: [...(input.subagents ?? [])],
    workflowWorld: cloneCompiledWorkflowWorldPlan(input.workflowWorld),
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };
  assertWorkspaceResourceRootSemantics(manifest, {
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    requireContentHash: false,
  });
  assertValidCompiledChannelRoutePlan({
    bindings: manifest.bindings,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    plan: manifest.channelRoutes,
  });
  for (const subagent of manifest.subagents) {
    assertValidCompiledChannelRoutePlan({
      bindings: subagent.agent.bindings,
      nodeId: subagent.nodeId,
      plan: subagent.agent.channelRoutes,
    });
    assertWorkspaceResourceRootSemantics(subagent.agent, {
      nodeId: subagent.nodeId,
      requireContentHash: false,
    });
  }
  assertCompiledAgentManifestSemantics(manifest);
  return manifest;
}

function cloneCompiledWorkflowWorldPlan(
  plan: CompiledWorkflowWorldPlan,
): CompiledWorkflowWorldPlan {
  if (plan.kind === "native") return { ...plan };
  return {
    backing: {
      entryPackageId: plan.backing.entryPackageId,
      entryPath: plan.backing.entryPath,
      identitySha256: plan.backing.identitySha256,
      mode: plan.backing.mode,
      packages: plan.backing.packages.map((selectedPackage) => ({
        ...selectedPackage,
        dependencies: { ...selectedPackage.dependencies },
      })),
    },
    kind: "host-module",
    packageName: plan.packageName,
    protocol: { ...plan.protocol },
    selection: "configured",
  };
}

function cloneCompiledExternalDependencyPlan(
  plan: CompiledExternalDependencyPlan,
): CompiledExternalDependencyPlan {
  return {
    entries: plan.entries.map((entry) => ({
      ...entry,
      conditions: [...entry.conditions],
      packages: entry.packages.map((pkg) => ({
        ...pkg,
        dependencies: pkg.dependencies.map((dependency) => ({ ...dependency })),
      })),
      scopes: entry.scopes.map((scope) => ({ ...scope })),
    })),
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
  if (model.maxOutputTokens !== undefined) {
    clone.maxOutputTokens = model.maxOutputTokens;
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
