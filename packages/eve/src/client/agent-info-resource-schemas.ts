import { z } from "#compiled/zod/index.js";

export const owner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }).strict(),
  z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
  z
    .object({
      kind: z.literal("extension"),
      namespace: z.string(),
      packageName: z.string(),
    })
    .strict(),
]);

export const sourceKind = z.enum(["markdown", "module", "skill-package", "subagent", "workspace"]);

export const source = z
  .object({
    exportName: z.string().optional(),
    logicalPath: z.string(),
    owner,
    sourceId: z.string(),
    sourceKind,
  })
  .strict();

export const moduleSource = source.extend({ sourceKind: z.literal("module") }).strict();
export const entry = source.extend({ name: z.string() }).strict();
export const moduleEntry = entry.extend({ sourceKind: z.literal("module") }).strict();
export const subagentEntry = entry.extend({ sourceKind: z.literal("subagent") }).strict();

export const dynamicResolver = moduleSource
  .extend({
    eventNames: z.array(z.string()),
  })
  .strict();

export const namedDynamicResolver = dynamicResolver.extend({ slug: z.string() }).strict();

export const modelRouting = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() })
    .strict(),
  z.object({ kind: z.literal("external"), provider: z.string() }).strict(),
]);

export const modelEndpoint = z.union([
  z.object({ kind: z.literal("external"), provider: z.string() }).strict(),
  z
    .object({
      kind: z.literal("chatgpt"),
      state: z.enum(["checking", "ready", "signed-out", "reauth-required", "unavailable"]),
      accountLabel: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gateway"),
      connected: z.literal(true),
      credential: z.enum(["api-key", "oidc"]),
    })
    .strict(),
  z.object({ kind: z.literal("gateway"), connected: z.literal(false) }).strict(),
]);

export const agentReasoning = z
  .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
  .optional();

export const staticAgentModelFields = {
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  providerOptions: z.unknown().optional(),
  reasoning: agentReasoning,
};

export const agentModel = z.union([
  z
    .object({
      ...staticAgentModelFields,
      endpoint: modelEndpoint.optional(),
      id: z.string(),
      routing: modelRouting,
      source: moduleSource.optional(),
    })
    .strict(),
  z
    .object({
      contextWindowTokens: z.never().optional(),
      endpoint: z.never().optional(),
      id: z.never().optional(),
      maxOutputTokens: z.never().optional(),
      providerOptions: z.never().optional(),
      reasoning: agentReasoning,
      routing: z
        .object({
          kind: z.literal("dynamic"),
          resolver: dynamicResolver,
        })
        .strict(),
      source: z.never().optional(),
    })
    .strict(),
]);

export const tool = moduleEntry
  .extend({
    description: z.string(),
    hasAuth: z.boolean(),
    hasExecute: z.boolean(),
    hasModelOutputProjection: z.boolean(),
    hasOutputSchema: z.boolean(),
    inputSchema: z.unknown(),
    outputSchema: z.unknown().optional(),
    requiresApproval: z.boolean(),
  })
  .strict();

export const skill = entry
  .extend({
    description: z.string(),
    license: z.string().optional(),
    markdown: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
    sourceKind: z.enum(["markdown", "module", "skill-package"]),
  })
  .strict();

export const instructions = entry
  .extend({
    content: z.string(),
    role: z.enum(["system", "user"]),
    sourceKind: z.enum(["markdown", "module"]),
  })
  .strict();

export const schedule = entry
  .extend({
    cron: z.string(),
    hasRun: z.boolean(),
    markdown: z.string().optional(),
    sourceKind: z.enum(["markdown", "module"]),
  })
  .strict();

export const localSubagentBase = subagentEntry
  .extend({
    entryPath: z.string(),
    nodeId: z.string(),
    parentNodeId: z.string(),
    rootPath: z.string(),
    summary: z
      .object({
        channels: z.number().int().nonnegative(),
        connections: z.number().int().nonnegative(),
        hooks: z.number().int().nonnegative(),
        instructions: z.boolean(),
        schedules: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        tools: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const localSubagent = z.union([
  localSubagentBase
    .extend({
      configResolver: z.never().optional(),
      description: z.string(),
    })
    .strict(),
  localSubagentBase
    .extend({
      configResolver: dynamicResolver,
      description: z.never().optional(),
    })
    .strict(),
]);

export const remoteAgent = subagentEntry
  .extend({
    configResolver: moduleSource,
    description: z.string(),
    entryPath: z.string(),
    nodeId: z.string(),
    outputSchema: z.unknown().optional(),
    parentNodeId: z.string(),
    path: z.string(),
    rootPath: z.string(),
    url: z.string().min(1).optional(),
  })
  .strict();

export const channelMethod = z.enum([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "WEBSOCKET",
]);

export const channel = moduleEntry
  .extend({
    adapterKind: z.string().optional(),
    method: channelMethod,
    urlPath: z.string(),
  })
  .strict();

export const connection = moduleSource
  .extend({
    connectionName: z.string(),
    description: z.string(),
    hasApproval: z.boolean(),
    hasAuthorization: z.boolean(),
    hasHeaders: z.boolean(),
    protocol: z.enum(["mcp", "openapi"]),
    url: z.string(),
  })
  .strict();

export const hook = moduleSource
  .extend({
    eventNames: z.array(z.string()),
    slug: z.string(),
  })
  .strict();

export const sandbox = moduleSource
  .extend({
    backendKind: z.string().optional(),
    description: z.string().optional(),
    hasBootstrap: z.boolean(),
    hasOnSession: z.boolean(),
    revalidationKey: z.string().optional(),
    sourceHash: z.string(),
  })
  .strict();

export const compositionSource = source
  .extend({
    layer: z.enum(["framework-default", "extension-package", "extension-override", "application"]),
  })
  .strict();

export const selectedCompositionSource = z.discriminatedUnion("sourceKind", [
  z
    .object({
      slot: z.string(),
      source: moduleSource,
      sourceKind: z.literal("module"),
    })
    .strict(),
  z
    .object({
      slot: z.string(),
      source: compositionSource,
      sourceKind: z.literal("non-module"),
    })
    .strict(),
]);

export const shadowedChannelRoute = z
  .object({
    loser: channel,
    method: channelMethod,
    pathPattern: z.string(),
    winningSourceId: z.string(),
  })
  .strict();

export const kernelNativeCapability = z
  .object({
    canonicalPath: z.string(),
    description: z.string(),
    hasAuth: z.boolean(),
    hasExecute: z.boolean(),
    hasModelOutputProjection: z.boolean(),
    hasOutputSchema: z.boolean(),
    inputSchema: z.null(),
    kind: z.literal("native"),
    name: z.string(),
    outputSchema: z.null(),
    requiresApproval: z.boolean(),
    sourceKind: z.literal("kernel"),
  })
  .strict();

export const workspaceResourceRoot = z
  .object({
    contentHash: z.string().optional(),
    logicalPath: z.string(),
    rootEntries: z.array(z.string()),
  })
  .strict();
