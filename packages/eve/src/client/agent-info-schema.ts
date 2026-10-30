import { z } from "#compiled/zod/index.js";
import { mountIdSchema } from "#shared/extension-mount.js";

/** Bumped only for breaking reshapes; additive changes keep the version. */
export const AGENT_INFO_VERSION = 5;

/**
 * A value set the server may grow. Older clients read a newer string as
 * `"unrecognized"` instead of rejecting the whole inspection payload; a missing
 * or non-string value is still malformed and fails the parse.
 */
function openEnum<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.union([z.enum(values), z.string().transform(() => "unrecognized" as const)]);
}

const owner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }),
  z.object({ feature: z.string(), kind: z.literal("framework") }),
  z.object({
    kind: z.literal("extension"),
    mountId: mountIdSchema.optional(),
    namespace: z.string(),
    packageName: z.string(),
  }),
]);

const moduleBacking = z.discriminatedUnion("kind", [
  z.object({
    externalDependencies: z.array(z.string()),
    extensionScope: z.object({ namespace: z.string(), sourceRoot: z.string() }).optional(),
    kind: z.literal("filesystem"),
    mountId: z.string().optional(),
    sourcePath: z.string(),
  }),
  z.object({
    dependencies: z.record(z.string(), z.string()).optional(),
    kind: z.literal("programmatic"),
    mountId: z.string().optional(),
    moduleId: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    registryId: z.string(),
    revision: z.string(),
    semanticRevision: z.string().optional(),
  }),
]);

const binding = z.object({
  backing: moduleBacking,
  logicalPath: z.string(),
  owner,
});

const source = z.object({
  binding: binding.optional(),
  exportName: z.string().optional(),
  logicalPath: z.string(),
  owner,
  sourceId: z.string(),
  sourceKind: openEnum(["markdown", "module", "skill-package"]),
});

type ParsedAgentInfoSource = z.output<typeof source>;

const entry = source.extend({ name: z.string() });

const dynamicResolver = source.extend({ slug: z.string() });

const modelRouting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() }),
  z.object({ kind: z.literal("external"), provider: z.string() }),
]);

const modelEndpoint = z.union([
  z.object({ kind: z.literal("external"), provider: z.string() }),
  z.object({
    kind: z.literal("chatgpt"),
    state: openEnum(["checking", "ready", "signed-out", "reauth-required", "unavailable"]),
    accountLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(true),
    credential: openEnum(["api-key", "oidc", "oauth"]),
    team: z.optional(z.string()),
  }),
  z.object({ kind: z.literal("gateway"), connected: z.literal(false) }),
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
  z.object({
    ...modelBaseFields,
    endpoint: modelEndpoint.optional(),
    id: z.string(),
    routing: modelRouting,
  }),
  z.object({
    ...modelBaseFields,
    endpoint: z.never().optional(),
    id: z.never().optional(),
    routing: z.object({ kind: z.literal("dynamic"), resolver: dynamicResolver }),
  }),
]);

const tool = entry.extend({
  description: z.string(),
  hasAuth: z.boolean(),
  hasExecute: z.boolean(),
  hasModelOutputProjection: z.boolean(),
  hasOutputSchema: z.boolean(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  requiresApproval: z.boolean(),
});

const skill = entry.extend({
  description: z.string(),
  license: z.string().optional(),
  markdown: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const instructions = entry.extend({
  content: z.string(),
  role: openEnum(["system", "user"]),
});

const schedule = entry.extend({
  cron: z.string(),
  hasRun: z.boolean(),
  markdown: z.string().optional(),
});

const channelMethod = openEnum([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "WEBSOCKET",
]);

const channelRoute = entry.extend({
  adapterKind: z.string().optional(),
  method: channelMethod,
  urlPath: z.string(),
});

const sourceDescriptor = z.object({
  backing: z.union([
    moduleBacking,
    z.object({ kind: z.literal("resource"), sourcePath: z.string() }),
  ]),
  form: openEnum(["derived", "direct"]),
  layer: openEnum(["framework-default", "extension-package", "extension-override", "application"]),
  logicalPath: z.string(),
  owner,
  sourceId: z.string(),
});

const shadowedChannelRoute = z.object({
  method: channelMethod,
  source: sourceDescriptor,
  urlPath: z.string(),
  winnerSourceId: z.string(),
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

const hook = source.extend({ eventNames: z.array(z.string()), slug: z.string() });

const memory = source.extend({
  description: z.string().optional(),
  slot: z.string(),
});

const sandbox = source.extend({
  provider: z.string().optional(),
  environmentExportName: z.string().optional(),
  revisionHash: z.string(),
});

const subagent = entry.extend({
  configResolver: dynamicResolver.optional(),
  description: z.string().optional(),
  entryPath: z.string(),
  nodeId: z.string(),
  parentNodeId: z.string(),
  rootPath: z.string(),
  summary: z.object({
    channels: z.number(),
    connections: z.number(),
    hooks: z.number(),
    instructions: z.number(),
    memories: z.number(),
    schedules: z.number(),
    skills: z.number(),
    tools: z.number(),
  }),
});

const remoteAgent = entry.extend({
  description: z.string(),
  nodeId: z.string(),
  parentNodeId: z.string(),
  url: z.string().optional(),
});

const kernelEffect = z.object({
  action: openEnum(["subagent-call", "workflow-tool-call"]).optional(),
  audience: z.array(openEnum(["root-session"])),
  kind: openEnum(["dispatch", "provider-tool"]),
  sourceId: z.string(),
});

const compositionDiagnostic = z.object({
  kind: openEnum(["disabled", "shadowed"]),
  logicalPath: z.string(),
  owner,
  sourceId: z.string(),
  winnerSourceId: z.string().optional(),
});

/**
 * Runtime contract for the authoritative `/eve/v1/info` v5 response. Parsing is
 * tolerant so a server may add fields and enum values without a version bump:
 * unknown keys are stripped and unknown enum strings read as `"unrecognized"`.
 * Discriminated-union `kind` fields stay closed, so a new variant needs a
 * version bump.
 */
export const AgentInfoResultSchema = z
  .object({
    agent: z.object({
      agentRoot: z.string(),
      appRoot: z.string(),
      config: source.extend({ binding }),
      description: z.string().optional(),
      model: agentModel,
      name: z.string(),
      nodeId: z.string(),
      outputSchema: z.unknown().optional(),
    }),
    capabilities: z.object({ devRoutes: z.boolean() }),
    channels: z.object({ routes: z.array(channelRoute), shadowed: z.array(shadowedChannelRoute) }),
    composition: z.object({
      disabled: z.array(compositionDiagnostic),
      shadowed: z.array(compositionDiagnostic),
    }),
    connections: z.array(connection),
    diagnostics: z.object({ discoveryErrors: z.number(), discoveryWarnings: z.number() }),
    hooks: z.array(hook),
    instructions: z.object({ dynamic: z.array(dynamicResolver), static: z.array(instructions) }),
    instrumentation: source.optional(),
    kernelEffects: z.array(kernelEffect),
    kind: z.literal("eve-agent-info"),
    memories: z.array(memory),
    mode: openEnum(["development", "production"]),
    remoteAgents: z.object({ entries: z.array(remoteAgent), total: z.number() }),
    sandbox,
    schedules: z.array(schedule),
    skills: z.object({ dynamic: z.array(dynamicResolver), static: z.array(skill) }),
    subagents: z.object({ local: z.array(subagent), total: z.number() }),
    tools: z.object({ dynamic: z.array(dynamicResolver), static: z.array(tool) }),
    version: z.literal(AGENT_INFO_VERSION),
    workspace: z.object({ resourceRoot: z.unknown(), rootEntries: z.array(z.string()) }),
  })
  .superRefine((value, context) => {
    const assertUnique = <Entry>(
      entries: readonly Entry[],
      identity: (entry: Entry) => string | undefined,
      path: readonly (string | number)[],
    ) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const key = identity(entry);
        if (key === undefined) return;
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
    // Distinct methods this client does not know all read as "unrecognized", so
    // they cannot be compared; a newer server may serve several on one path.
    assertUnique(
      value.channels.routes,
      (entry) =>
        entry.method === "unrecognized"
          ? undefined
          : `${entry.method} ${normalizeRoutePattern(entry.urlPath)}`,
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
      // A source kind this client does not know may legitimately be bound.
      if (
        entry.sourceKind !== "module" &&
        entry.sourceKind !== "unrecognized" &&
        entry.binding !== undefined
      ) {
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

/**
 * Names which side to upgrade when an agent-info body carries another version,
 * so the caller sees one actionable issue instead of every reshaped field.
 */
export function describeAgentInfoVersionMismatch(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { kind, version } = payload as { kind?: unknown; version?: unknown };
  if (kind !== "eve-agent-info" || typeof version !== "number") return undefined;
  if (version === AGENT_INFO_VERSION) return undefined;
  const upgrade =
    version < AGENT_INFO_VERSION
      ? "Upgrade eve in the agent and redeploy it"
      : "Upgrade the eve package this client runs from";
  return `version: the server sent agent-info version ${version}, but this client reads version ${AGENT_INFO_VERSION}. ${upgrade}.`;
}

function normalizeRoutePattern(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => (segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment) ? ":" : segment))
    .join("/");
}

export type {
  AgentInfoResult,
  AgentInfoSource,
  AgentInfoEntry,
  AgentInfoToolEntry,
  AgentInfoDynamicResolverEntry,
  AgentInfoTools,
  AgentInfoSkillEntry,
  AgentInfoInstructionsEntry,
  AgentInfoInstructions,
  AgentInfoScheduleEntry,
  AgentInfoSubagentEntry,
  AgentInfoRemoteAgentEntry,
  AgentInfoChannelEntry,
  AgentInfoChannels,
  AgentInfoConnectionEntry,
  AgentInfoHookEntry,
  AgentInfoMemoryEntry,
  AgentInfoSandboxEntry,
} from "./agent-info-types.js";
