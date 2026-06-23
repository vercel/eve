import { z } from "zod";

const source = z.object({
  exportName: z.string().optional(),
  logicalPath: z.string(),
  sourceId: z.string().optional(),
  sourceKind: z.string(),
});

const entry = source.extend({ name: z.string() });

const modelRouting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() }),
  z.object({ kind: z.literal("external"), provider: z.string() }),
]);

const modelEndpoint = z.union([
  z.object({ kind: z.literal("external"), provider: z.string() }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(true),
    credential: z.enum(["api-key", "oidc"]),
  }),
  z.object({ kind: z.literal("gateway"), connected: z.literal(false) }),
]);

const tool = entry.extend({
  description: z.string(),
  hasAuth: z.boolean(),
  hasExecute: z.boolean(),
  hasModelOutputProjection: z.boolean(),
  hasOutputSchema: z.boolean(),
  inputSchema: z.unknown(),
  origin: z.enum(["authored", "framework"]),
  outputSchema: z.unknown().optional(),
  replacesFrameworkTool: z.boolean(),
  requiresApproval: z.boolean(),
});

const frameworkTool = tool.extend({
  disabledByAuthor: z.boolean(),
  replacedByAuthoredTool: z.boolean(),
  status: z.enum(["active", "disabled", "replaced"]),
});

const dynamicResolver = source.extend({
  eventNames: z.array(z.string()),
  origin: z.enum(["authored", "framework"]),
  slug: z.string(),
});

const skill = entry.extend({
  description: z.string(),
  license: z.string().optional(),
  markdown: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const instructions = entry.extend({ markdown: z.string() });

const schedule = entry.extend({
  cron: z.string(),
  hasRun: z.boolean(),
  markdown: z.string().optional(),
});

const subagent = entry.extend({
  description: z.string(),
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
  origin: z.enum(["authored", "framework"]),
  urlPath: z.string(),
});

const frameworkChannel = channel.extend({
  disabledByAuthor: z.boolean(),
  replacedByAuthoredChannel: z.boolean(),
  status: z.enum(["active", "disabled", "replaced"]),
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

/** Runtime contract for the complete `/eve/v1/info` response. */
export const AgentInfoResultSchema = z.object({
  agent: z.object({
    agentRoot: z.string(),
    appRoot: z.string(),
    configSource: source.optional(),
    description: z.string().optional(),
    model: z.object({
      contextWindowTokens: z.number().optional(),
      id: z.string(),
      providerOptions: z.unknown().optional(),
      source: source.optional(),
      routing: modelRouting.optional(),
      endpoint: modelEndpoint.optional(),
    }),
    name: z.string(),
    outputSchema: z.unknown().optional(),
  }),
  capabilities: z.object({ devRoutes: z.boolean() }),
  channels: z.object({
    authored: z.array(channel),
    available: z.array(channel),
    disabledFramework: z.array(z.string()),
    framework: z.array(frameworkChannel),
  }),
  connections: z.array(connection),
  diagnostics: z.object({
    discoveryErrors: z.number(),
    discoveryWarnings: z.number(),
  }),
  hooks: z.array(hook),
  instructions: z.object({
    dynamic: z.array(dynamicResolver),
    static: instructions.nullable(),
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
    authored: z.array(tool),
    available: z.array(tool),
    disabledFramework: z.array(z.string()),
    dynamic: z.array(dynamicResolver),
    framework: z.array(frameworkTool),
    reserved: z.array(z.string()),
  }),
  version: z.literal(1),
  workflow: z.object({
    enabled: z.boolean(),
    toolName: z.string(),
  }),
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

export type AgentInfoSource = ReadonlyDeep<z.output<typeof source>>;
export type AgentInfoEntry = ReadonlyDeep<z.output<typeof entry>>;
export type AgentInfoToolEntry = ReadonlyDeep<z.output<typeof tool>>;
export type AgentInfoFrameworkToolEntry = ReadonlyDeep<z.output<typeof frameworkTool>>;
export type AgentInfoDynamicResolverEntry = ReadonlyDeep<z.output<typeof dynamicResolver>>;
export type AgentInfoTools = AgentInfoResult["tools"];
export type AgentInfoSkillEntry = ReadonlyDeep<z.output<typeof skill>>;
export type AgentInfoInstructionsEntry = ReadonlyDeep<z.output<typeof instructions>>;
export type AgentInfoInstructions = AgentInfoResult["instructions"];
export type AgentInfoScheduleEntry = ReadonlyDeep<z.output<typeof schedule>>;
export type AgentInfoSubagentEntry = ReadonlyDeep<z.output<typeof subagent>>;
export type AgentInfoChannelEntry = ReadonlyDeep<z.output<typeof channel>>;
export type AgentInfoFrameworkChannelEntry = ReadonlyDeep<z.output<typeof frameworkChannel>>;
export type AgentInfoChannels = AgentInfoResult["channels"];
export type AgentInfoConnectionEntry = ReadonlyDeep<z.output<typeof connection>>;
export type AgentInfoHookEntry = ReadonlyDeep<z.output<typeof hook>>;
export type AgentInfoSandboxEntry = ReadonlyDeep<z.output<typeof sandbox>>;
export type AgentInfoResult = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
