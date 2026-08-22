import { z } from "#compiled/zod/index.js";

const owner = z.discriminatedUnion("kind", [
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

const source = z.object({
  exportName: z.string().optional(),
  logicalPath: z.string(),
  owner,
  sourceId: z.string().optional(),
  sourceKind: z.string(),
});

const compositionSource = z.object({
  logicalPath: z.string(),
  owner,
  sourceId: z.string(),
});

const entry = source.extend({ name: z.string() });

const modelRouting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() }),
  z.object({ kind: z.literal("external"), provider: z.string() }),
]);

const modelEndpoint = z.union([
  z.object({ kind: z.literal("external"), provider: z.string() }),
  z.object({
    kind: z.literal("chatgpt"),
    state: z.enum(["checking", "ready", "signed-out", "reauth-required", "unavailable"]),
    accountLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(true),
    credential: z.enum(["api-key", "oidc"]),
  }),
  z.object({ kind: z.literal("gateway"), connected: z.literal(false) }),
]);

const agentModelBaseFields = {
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
      ...agentModelBaseFields,
      id: z.string(),
      routing: modelRouting,
      endpoint: modelEndpoint.optional(),
    })
    .strict(),
  z
    .object({
      ...agentModelBaseFields,
      endpoint: z.never().optional(),
      id: z.never().optional(),
      routing: z.object({ kind: z.literal("dynamic") }).strict(),
    })
    .strict(),
]);

const tool = entry.extend({
  description: z.string(),
  hasAuth: z.literal(false),
  hasExecute: z.boolean(),
  hasModelOutputProjection: z.boolean(),
  hasOutputSchema: z.boolean(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  requiresApproval: z.boolean(),
});

const dynamicResolver = source.extend({
  eventNames: z.array(z.string()),
  slug: z.string(),
});

const skill = entry.extend({
  description: z.string(),
  license: z.string().optional(),
  markdown: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const instructions = entry.extend({
  content: z.string(),
  role: z.enum(["system", "user"]),
});

const schedule = entry.extend({
  cron: z.string(),
  hasRun: z.boolean(),
  markdown: z.string().optional(),
});

const subagent = entry.extend({
  description: z.string().optional(),
  entryPath: z.string(),
  nodeId: z.string(),
  rootPath: z.string(),
  summary: z.object({
    channels: z.number(),
    connections: z.number(),
    hooks: z.number(),
    instructions: z.boolean(),
    schedules: z.number(),
    skills: z.number(),
    tools: z.number(),
  }),
});

const channel = entry.extend({
  adapterKind: z.string().optional(),
  method: z.string(),
  urlPath: z.string(),
});

const connection = source.extend({
  connectionName: z.string(),
  description: z.string(),
  hasApproval: z.boolean(),
  hasAuthorization: z.boolean(),
  hasHeaders: z.boolean(),
  protocol: z.string(),
  toolFilter: z.unknown().optional(),
  url: z.string(),
});

const hook = source.extend({
  eventNames: z.array(z.string()),
  slug: z.string(),
});

const sandbox = source.extend({
  backendKind: z.string().optional(),
  description: z.string().optional(),
  hasBootstrap: z.boolean(),
  hasOnSession: z.boolean(),
  revalidationKey: z.string().optional(),
  sourceHash: z.string().optional(),
});

const kernelCapability = z.object({
  audience: z.enum(["all-sessions", "root-node", "task-child", "turn-output"]),
  canonicalPath: z.string(),
  conditions: z.array(
    z.enum([
      "root-node",
      "tasks-enabled",
      "task-child",
      "request-input-supported",
      "skills-present",
      "model-supports-provider-tools",
      "workflow-node-eligible",
      "structured-output-requested",
    ]),
  ),
  materialization: z.enum(["harness", "provider", "runtime-action", "tool-loop"]),
  name: z.string(),
});

/** Runtime contract for the complete `/eve/v1/info` response. */
export const AgentInfoResultSchema = z.object({
  agent: z.object({
    agentRoot: z.string(),
    appRoot: z.string(),
    configSource: source.optional(),
    description: z.string().optional(),
    model: agentModel,
    name: z.string(),
    outputSchema: z.unknown().optional(),
  }),
  capabilities: z.object({ devRoutes: z.boolean() }),
  channels: z.array(channel),
  composition: z.object({
    disabled: z.array(
      z.object({
        slot: z.string(),
        source: compositionSource,
        target: compositionSource.optional(),
      }),
    ),
    shadowed: z.array(
      z.object({
        by: compositionSource,
        slot: z.string(),
        source: compositionSource,
      }),
    ),
  }),
  connections: z.array(connection),
  diagnostics: z.object({
    discoveryErrors: z.number(),
    discoveryWarnings: z.number(),
  }),
  hooks: z.array(hook),
  instructions: z.object({
    dynamic: z.array(dynamicResolver),
    static: z.array(instructions),
  }),
  kernel: z.object({
    prepared: z.array(kernelCapability),
    reserved: z.array(kernelCapability),
  }),
  kind: z.literal("eve-agent-info"),
  mode: z.enum(["development", "production"]),
  sandbox: sandbox.nullable(),
  schedules: z.array(schedule),
  skills: z.object({
    dynamic: z.array(dynamicResolver),
    static: z.array(skill),
  }),
  subagents: z.object({
    local: z.array(subagent),
    total: z.number(),
  }),
  tools: z.object({
    dynamic: z.array(dynamicResolver),
    static: z.array(tool),
  }),
  version: z.literal(3),
  workspace: z.object({
    resourceRoot: z.unknown(),
    rootEntries: z.array(z.string()),
  }),
});

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

export type AgentInfoOwner = ReadonlyDeep<z.output<typeof owner>>;
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
export type AgentInfoChannelEntry = ReadonlyDeep<z.output<typeof channel>>;
export type AgentInfoChannels = AgentInfoResult["channels"];
export type AgentInfoConnectionEntry = ReadonlyDeep<z.output<typeof connection>>;
export type AgentInfoHookEntry = ReadonlyDeep<z.output<typeof hook>>;
export type AgentInfoSandboxEntry = ReadonlyDeep<z.output<typeof sandbox>>;
export type AgentInfoKernelCapabilityEntry = ReadonlyDeep<z.output<typeof kernelCapability>>;
export type AgentInfoComposition = AgentInfoResult["composition"];
export type AgentInfoResult = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
