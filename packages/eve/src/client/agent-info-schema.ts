import { z } from "#compiled/zod/index.js";

const owner = z.enum(["application", "extension", "framework"]);

/** Binding provenance of one active compiled definition. */
const source = z.object({
  logicalPath: z.string(),
  owner,
  sourceId: z.string(),
});

/** One active dynamic resolver with its exact subscribed events. */
const dynamicResolver = z.object({
  events: z.array(z.string()),
  logicalPath: z.string(),
  owner,
  slug: z.string().optional(),
  sourceId: z.string(),
});

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
  // An unrecognized future effort level degrades to absent, not a parse failure.
  reasoning: z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .catch(undefined),
};

const agentModel = z.union([
  z
    .object({
      ...agentModelBaseFields,
      endpoint: modelEndpoint.optional(),
      id: z.string(),
      routing: z.object({ kind: z.literal("static") }).strict(),
    })
    .strict(),
  z
    .object({
      ...agentModelBaseFields,
      endpoint: z.never().optional(),
      id: z.never().optional(),
      routing: z.object({ kind: z.literal("dynamic"), resolver: dynamicResolver }).strict(),
    })
    .strict(),
]);

const tool = z.object({
  description: z.string(),
  execution: z.literal("background").optional(),
  hasAuth: z.boolean(),
  inputSchema: z.unknown(),
  name: z.string(),
  outputSchema: z.unknown().optional(),
  source,
});

const skill = z.object({
  description: z.string(),
  name: z.string(),
  source,
});

const instructions = z.object({
  content: z.string(),
  name: z.string(),
  role: z.enum(["system", "user"]),
  source,
});

const schedule = z.object({
  cron: z.string(),
  hasRun: z.boolean(),
  name: z.string(),
  source,
});

const connection = z.object({
  description: z.string(),
  name: z.string(),
  protocol: z.string(),
  source,
  url: z.string(),
});

const hook = z.object({
  slug: z.string(),
  source,
});

const sandbox = z.object({
  backendName: z.string().optional(),
  description: z.string().optional(),
  source,
});

/** One mounted channel route, in exact mount order. */
const channelRoute = z.object({
  adapterKind: z.string().optional(),
  channelName: z.string(),
  method: z.string(),
  path: z.string(),
  source,
});

const shadowedChannelRoute = channelRoute.extend({
  winningSourceId: z.string(),
});

/** One kernel effect prepared from a surviving framework tool slot. */
const kernelPrepared = z.object({
  action: z.enum(["subagent-call", "task-update", "task-cancel"]).optional(),
  kind: z.enum(["request-input", "dispatch", "provider-tool"]),
  source,
  toolName: z.string(),
});

const subagent = z.object({
  configResolver: dynamicResolver.optional(),
  description: z.string().optional(),
  name: z.string(),
  nodeId: z.string(),
  parentNodeId: z.string(),
  source,
});

const remoteAgent = z.object({
  description: z.string().optional(),
  name: z.string(),
  nodeId: z.string(),
  parentNodeId: z.string(),
  source,
  url: z.string().optional(),
});

const disabledComposition = z.object({
  logicalPath: z.string(),
  nodeId: z.string(),
  owner,
  slot: z.string(),
});

const shadowedComposition = disabledComposition.extend({
  winningSourceId: z.string(),
});

/** Runtime contract for the complete `/eve/v1/info` response. */
export const AgentInfoResultSchema = z.object({
  agent: z.object({
    agentRoot: z.string(),
    appRoot: z.string(),
    config: z.object({ source }),
    description: z.string().optional(),
    model: agentModel,
    name: z.string(),
    nodeId: z.string(),
    outputSchema: z.unknown().optional(),
  }),
  capabilities: z.object({ devRoutes: z.boolean() }),
  channels: z.object({
    routes: z.array(channelRoute),
    shadowed: z.array(shadowedChannelRoute),
    total: z.number(),
  }),
  composition: z.object({
    disabled: z.array(disabledComposition),
    shadowed: z.array(shadowedComposition),
  }),
  connections: z.array(connection),
  diagnostics: z.object({
    discoveryErrors: z.number(),
    discoveryWarnings: z.number(),
  }),
  hooks: z.array(hook),
  instructions: z.object({
    dynamicResolvers: z.array(dynamicResolver),
    entries: z.array(instructions),
  }),
  kernel: z.object({
    prepared: z.array(kernelPrepared),
  }),
  kind: z.literal("eve-agent-info"),
  mode: z.enum(["development", "production"]),
  remoteAgents: z.object({
    entries: z.array(remoteAgent),
    total: z.number(),
  }),
  sandbox,
  schedules: z.array(schedule),
  skills: z.object({
    dynamicResolvers: z.array(dynamicResolver),
    entries: z.array(skill),
  }),
  subagents: z.object({
    local: z.array(subagent),
    total: z.number(),
  }),
  tools: z.object({
    dynamicResolvers: z.array(dynamicResolver),
    entries: z.array(tool),
  }),
  version: z.literal(3),
  workspace: z.object({
    rootEntries: z.array(z.string()),
  }),
});

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

export type AgentInfoOwner = z.output<typeof owner>;
export type AgentInfoSource = ReadonlyDeep<z.output<typeof source>>;
export type AgentInfoDynamicResolverEntry = ReadonlyDeep<z.output<typeof dynamicResolver>>;
export type AgentInfoModel = AgentInfoResult["agent"]["model"];
export type AgentInfoToolEntry = ReadonlyDeep<z.output<typeof tool>>;
export type AgentInfoTools = AgentInfoResult["tools"];
export type AgentInfoSkillEntry = ReadonlyDeep<z.output<typeof skill>>;
export type AgentInfoInstructionsEntry = ReadonlyDeep<z.output<typeof instructions>>;
export type AgentInfoInstructions = AgentInfoResult["instructions"];
export type AgentInfoScheduleEntry = ReadonlyDeep<z.output<typeof schedule>>;
export type AgentInfoConnectionEntry = ReadonlyDeep<z.output<typeof connection>>;
export type AgentInfoHookEntry = ReadonlyDeep<z.output<typeof hook>>;
export type AgentInfoSandboxEntry = ReadonlyDeep<z.output<typeof sandbox>>;
export type AgentInfoChannelRouteEntry = ReadonlyDeep<z.output<typeof channelRoute>>;
export type AgentInfoShadowedChannelRouteEntry = ReadonlyDeep<
  z.output<typeof shadowedChannelRoute>
>;
export type AgentInfoChannels = AgentInfoResult["channels"];
export type AgentInfoKernelPreparedEntry = ReadonlyDeep<z.output<typeof kernelPrepared>>;
export type AgentInfoKernel = AgentInfoResult["kernel"];
export type AgentInfoSubagentEntry = ReadonlyDeep<z.output<typeof subagent>>;
export type AgentInfoRemoteAgentEntry = ReadonlyDeep<z.output<typeof remoteAgent>>;
export type AgentInfoDisabledCompositionEntry = ReadonlyDeep<z.output<typeof disabledComposition>>;
export type AgentInfoShadowedCompositionEntry = ReadonlyDeep<z.output<typeof shadowedComposition>>;
export type AgentInfoComposition = AgentInfoResult["composition"];
export type AgentInfoResult = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
