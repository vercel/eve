import { z } from "#compiled/zod/index.js";

const owner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }).strict(),
  z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
  z
    .object({ kind: z.literal("extension"), namespace: z.string(), packageName: z.string() })
    .strict(),
]);

const moduleBacking = z.discriminatedUnion("kind", [
  z
    .object({
      externalDependencies: z.array(z.string()),
      extensionScope: z
        .object({ namespace: z.string(), sourceRoot: z.string() })
        .strict()
        .optional(),
      kind: z.literal("filesystem"),
      sourcePath: z.string(),
    })
    .strict(),
  z
    .object({
      dependencies: z.record(z.string(), z.string()).optional(),
      kind: z.literal("programmatic"),
      metadata: z.record(z.string(), z.unknown()).optional(),
      moduleId: z.string(),
      registryId: z.string(),
      revision: z.string(),
      semanticRevision: z.string().optional(),
    })
    .strict(),
]);

const binding = z
  .object({
    backing: moduleBacking,
    logicalPath: z.string(),
    owner,
  })
  .strict();

const source = z
  .object({
    binding: binding.optional(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    owner,
    sourceId: z.string(),
    sourceKind: z.enum(["markdown", "module", "skill-package"]),
  })
  .strict();

type ParsedAgentInfoSource = z.output<typeof source>;

const entry = source.extend({ name: z.string() }).strict();

const dynamicResolver = source
  .extend({
    eventNames: z.array(z.string()),
    slug: z.string(),
  })
  .strict();

const modelRouting = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() })
    .strict(),
  z.object({ kind: z.literal("external"), provider: z.string() }).strict(),
]);

const modelEndpoint = z.union([
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

const modelBaseFields = {
  contextWindowTokens: z.number().optional(),
  providerOptions: z.unknown().optional(),
  reasoning: z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .catch(undefined),
  source: source.optional(),
};

const agentModel = z.union([
  z
    .object({
      ...modelBaseFields,
      endpoint: modelEndpoint.optional(),
      id: z.string(),
      routing: modelRouting,
    })
    .strict(),
  z
    .object({
      ...modelBaseFields,
      endpoint: z.never().optional(),
      id: z.never().optional(),
      routing: z.object({ kind: z.literal("dynamic"), resolver: dynamicResolver }).strict(),
    })
    .strict(),
]);

const tool = entry
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

const skill = entry
  .extend({
    description: z.string(),
    license: z.string().optional(),
    markdown: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const instructions = entry
  .extend({ content: z.string(), role: z.enum(["system", "user"]) })
  .strict();

const schedule = entry
  .extend({ cron: z.string(), hasRun: z.boolean(), markdown: z.string().optional() })
  .strict();

const channelMethod = z.enum([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "WEBSOCKET",
]);

const channelRoute = entry
  .extend({ adapterKind: z.string().optional(), method: channelMethod, urlPath: z.string() })
  .strict();

const sourceDescriptor = z
  .object({
    backing: z.union([
      moduleBacking,
      z.object({ kind: z.literal("resource"), sourcePath: z.string() }).strict(),
    ]),
    layer: z.enum([
      "framework-default",
      "extension-package",
      "extension-override",
      "application-derived",
      "application",
    ]),
    logicalPath: z.string(),
    owner,
    sourceId: z.string(),
  })
  .strict();

const shadowedChannelRoute = z
  .object({
    method: channelMethod,
    source: sourceDescriptor,
    urlPath: z.string(),
    winnerSourceId: z.string(),
  })
  .strict();

const connection = source
  .extend({
    connectionName: z.string(),
    description: z.string(),
    hasApproval: z.boolean(),
    hasAuthorization: z.boolean(),
    hasHeaders: z.boolean(),
    protocol: z.string(),
    toolFilter: z.unknown().optional(),
    url: z.string(),
  })
  .strict();

const hook = source.extend({ eventNames: z.array(z.string()), slug: z.string() }).strict();

const memory = source
  .extend({
    description: z.string().optional(),
    slot: z.string(),
    tools: z.literal(false).optional(),
    visibility: z.enum(["scope", "session"]),
  })
  .strict();

const sandbox = source
  .extend({
    backendKind: z.string().optional(),
    description: z.string().optional(),
    hasBootstrap: z.boolean(),
    hasOnSession: z.boolean(),
    revalidationKey: z.string().optional(),
    sourceHash: z.string().optional(),
  })
  .strict();

const subagent = entry
  .extend({
    configResolver: dynamicResolver.optional(),
    description: z.string().optional(),
    entryPath: z.string(),
    nodeId: z.string(),
    parentNodeId: z.string(),
    rootPath: z.string(),
    summary: z
      .object({
        channels: z.number(),
        connections: z.number(),
        hooks: z.number(),
        instructions: z.number(),
        memories: z.number(),
        schedules: z.number(),
        skills: z.number(),
        tools: z.number(),
      })
      .strict(),
  })
  .strict();

const remoteAgent = entry
  .extend({
    description: z.string(),
    nodeId: z.string(),
    parentNodeId: z.string(),
    url: z.string().optional(),
  })
  .strict();

const kernelEffect = z
  .object({
    action: z.enum(["subagent-call", "task-update", "task-cancel"]).optional(),
    audience: z.array(
      z.enum([
        "root-session",
        "delegated-task-child",
        "requires-request-input",
        "requires-loadable-skill",
        "below-subagent-depth",
      ]),
    ),
    kind: z.enum(["request-input", "dispatch", "provider-tool"]),
    sourceId: z.string(),
  })
  .strict();

const compositionDiagnostic = z
  .object({
    kind: z.enum(["disabled", "shadowed"]),
    logicalPath: z.string(),
    owner,
    sourceId: z.string(),
    winnerSourceId: z.string().optional(),
  })
  .strict();

const workflow = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), toolName: z.string() }).strict(),
  z.object({ enabled: z.literal(true), source, toolName: z.string() }).strict(),
]);

/** Runtime contract for the authoritative `/eve/v1/info` v3 response. */
export const AgentInfoResultSchema = z
  .object({
    agent: z
      .object({
        agentRoot: z.string(),
        appRoot: z.string(),
        config: source.extend({ binding }).strict(),
        description: z.string().optional(),
        model: agentModel,
        name: z.string(),
        nodeId: z.string(),
        outputSchema: z.unknown().optional(),
      })
      .strict(),
    capabilities: z.object({ devRoutes: z.boolean() }).strict(),
    channels: z
      .object({ routes: z.array(channelRoute), shadowed: z.array(shadowedChannelRoute) })
      .strict(),
    composition: z
      .object({
        disabled: z.array(compositionDiagnostic),
        shadowed: z.array(compositionDiagnostic),
      })
      .strict(),
    connections: z.array(connection),
    diagnostics: z.object({ discoveryErrors: z.number(), discoveryWarnings: z.number() }).strict(),
    hooks: z.array(hook),
    instructions: z
      .object({ dynamic: z.array(dynamicResolver), static: z.array(instructions) })
      .strict(),
    instrumentation: source.optional(),
    kernelEffects: z.array(kernelEffect),
    kind: z.literal("eve-agent-info"),
    memories: z.array(memory),
    mode: z.enum(["development", "production"]),
    remoteAgents: z.object({ entries: z.array(remoteAgent), total: z.number() }).strict(),
    sandbox,
    schedules: z.array(schedule),
    skills: z.object({ dynamic: z.array(dynamicResolver), static: z.array(skill) }).strict(),
    subagents: z.object({ local: z.array(subagent), total: z.number() }).strict(),
    tools: z.object({ dynamic: z.array(dynamicResolver), static: z.array(tool) }).strict(),
    version: z.literal(4),
    workflow,
    workspace: z.object({ resourceRoot: z.unknown(), rootEntries: z.array(z.string()) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const assertUnique = <Entry>(
      entries: readonly Entry[],
      identity: (entry: Entry) => string,
      path: readonly (string | number)[],
    ) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const key = identity(entry);
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate public identity "${key}".`,
            path: [...path, index],
          });
        }
        seen.add(key);
      });
    };
    const assertTotal = (
      total: number,
      entries: readonly unknown[],
      path: readonly (string | number)[],
    ) => {
      if (!Number.isSafeInteger(total) || total < 0 || total !== entries.length) {
        context.addIssue({
          code: "custom",
          message: `Expected total ${entries.length}, received ${total}.`,
          path: [...path],
        });
      }
    };

    assertUnique(value.tools.static, (entry) => entry.name, ["tools", "static"]);
    assertUnique(value.tools.dynamic, (entry) => entry.slug, ["tools", "dynamic"]);
    assertUnique(value.skills.static, (entry) => entry.name, ["skills", "static"]);
    assertUnique(value.skills.dynamic, (entry) => entry.slug, ["skills", "dynamic"]);
    assertUnique(value.instructions.static, (entry) => entry.name, ["instructions", "static"]);
    assertUnique(value.instructions.dynamic, (entry) => entry.slug, ["instructions", "dynamic"]);
    assertUnique(value.schedules, (entry) => entry.name, ["schedules"]);
    assertUnique(value.connections, (entry) => entry.connectionName, ["connections"]);
    assertUnique(value.hooks, (entry) => entry.slug, ["hooks"]);
    assertUnique(value.memories, (entry) => entry.slot, ["memories"]);
    assertUnique(
      value.channels.routes,
      (entry) => `${entry.method} ${normalizeRoutePattern(entry.urlPath)}`,
      ["channels", "routes"],
    );
    assertUnique(value.subagents.local, (entry) => entry.nodeId, ["subagents", "local"]);
    assertUnique(value.remoteAgents.entries, (entry) => entry.nodeId, ["remoteAgents", "entries"]);
    assertTotal(value.subagents.total, value.subagents.local, ["subagents", "total"]);
    assertTotal(value.remoteAgents.total, value.remoteAgents.entries, ["remoteAgents", "total"]);

    const boundSources: ReadonlyArray<
      readonly [ParsedAgentInfoSource, readonly (string | number)[]]
    > = [
      [value.agent.config, ["agent", "config"]],
      ...(value.agent.model.source === undefined
        ? []
        : ([[value.agent.model.source, ["agent", "model", "source"]]] as const)),
      ...(value.agent.model.routing.kind === "dynamic"
        ? ([
            [value.agent.model.routing.resolver, ["agent", "model", "routing", "resolver"]],
          ] as const)
        : []),
      ...value.channels.routes.map(
        (entry, index) => [entry, ["channels", "routes", index]] as const,
      ),
      ...value.connections.map((entry, index) => [entry, ["connections", index]] as const),
      ...value.hooks.map((entry, index) => [entry, ["hooks", index]] as const),
      ...value.instructions.dynamic.map(
        (entry, index) => [entry, ["instructions", "dynamic", index]] as const,
      ),
      ...value.instructions.static.map(
        (entry, index) => [entry, ["instructions", "static", index]] as const,
      ),
      ...value.memories.map((entry, index) => [entry, ["memories", index]] as const),
      ...(value.instrumentation === undefined
        ? []
        : ([[value.instrumentation, ["instrumentation"]]] as const)),
      ...value.remoteAgents.entries.map(
        (entry, index) => [entry, ["remoteAgents", "entries", index]] as const,
      ),
      ...value.schedules.map((entry, index) => [entry, ["schedules", index]] as const),
      ...value.skills.dynamic.map((entry, index) => [entry, ["skills", "dynamic", index]] as const),
      ...value.skills.static.map((entry, index) => [entry, ["skills", "static", index]] as const),
      ...value.subagents.local.flatMap((entry, index) =>
        entry.configResolver === undefined
          ? []
          : ([[entry.configResolver, ["subagents", "local", index, "configResolver"]]] as const),
      ),
      ...value.tools.dynamic.map((entry, index) => [entry, ["tools", "dynamic", index]] as const),
      ...value.tools.static.map((entry, index) => [entry, ["tools", "static", index]] as const),
      ...(value.workflow.enabled
        ? ([[value.workflow.source, ["workflow", "source"]]] as const)
        : []),
      [value.sandbox, ["sandbox"]],
    ];
    for (const [entry, path] of boundSources) {
      if (entry.sourceKind === "module" && entry.binding === undefined) {
        context.addIssue({
          code: "custom",
          message: "Module source is missing its compiled binding.",
          path: [...path, "binding"],
        });
        continue;
      }
      if (entry.sourceKind !== "module" && entry.binding !== undefined) {
        context.addIssue({
          code: "custom",
          message: `${entry.sourceKind} source cannot carry a module binding.`,
          path: [...path, "binding"],
        });
        continue;
      }
      if (entry.binding === undefined) continue;
      if (entry.binding.logicalPath !== entry.logicalPath) {
        context.addIssue({
          code: "custom",
          message: "Source and binding logical paths do not match.",
          path: [...path, "binding", "logicalPath"],
        });
      }
      if (JSON.stringify(entry.binding.owner) !== JSON.stringify(entry.owner)) {
        context.addIssue({
          code: "custom",
          message: "Source and binding owners do not match.",
          path: [...path, "binding", "owner"],
        });
      }
    }
  });

function normalizeRoutePattern(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => (segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment) ? ":" : segment))
    .join("/");
}

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

export type AgentInfoResult = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
export type AgentInfoSource = ReadonlyDeep<z.output<typeof source>>;
export type AgentInfoEntry = ReadonlyDeep<z.output<typeof entry>>;
export type AgentInfoToolEntry = ReadonlyDeep<z.output<typeof tool>>;
export type AgentInfoDynamicResolverEntry = ReadonlyDeep<z.output<typeof dynamicResolver>>;
export type AgentInfoTools = AgentInfoResult["tools"];
export type AgentInfoSkillEntry = ReadonlyDeep<z.output<typeof skill>>;
export type AgentInfoInstructionsEntry = ReadonlyDeep<z.output<typeof instructions>>;
export type AgentInfoInstructions = AgentInfoResult["instructions"];
export type AgentInfoScheduleEntry = ReadonlyDeep<z.output<typeof schedule>>;
export type AgentInfoSubagentEntry = ReadonlyDeep<z.output<typeof subagent>>;
export type AgentInfoRemoteAgentEntry = ReadonlyDeep<z.output<typeof remoteAgent>>;
export type AgentInfoChannelEntry = ReadonlyDeep<z.output<typeof channelRoute>>;
export type AgentInfoChannels = AgentInfoResult["channels"];
export type AgentInfoConnectionEntry = ReadonlyDeep<z.output<typeof connection>>;
export type AgentInfoHookEntry = ReadonlyDeep<z.output<typeof hook>>;
export type AgentInfoMemoryEntry = ReadonlyDeep<z.output<typeof memory>>;
export type AgentInfoSandboxEntry = ReadonlyDeep<z.output<typeof sandbox>>;
