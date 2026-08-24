import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info.js";

const VALID_INFO = createTestAgentInfoResult();

describe("AgentInfoResultSchema", () => {
  it("accepts the complete strict v3 contract", () => {
    expect(AgentInfoResultSchema.parse(VALID_INFO)).toEqual(VALID_INFO);
  });

  it("requires source identity and ownership at every source boundary", () => {
    const { sourceId: _sourceId, ...configWithoutSourceId } = VALID_INFO.agent.configSource;
    const { owner: _owner, ...sandboxWithoutOwner } = VALID_INFO.sandbox;

    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: { ...VALID_INFO.agent, configSource: configWithoutSourceId },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({ ...VALID_INFO, sandbox: sandboxWithoutOwner }).success,
    ).toBe(false);
  });

  it("requires a dynamic model to nest its exact resolver provenance", () => {
    const resolver = {
      eventNames: ["session.started", "turn.started"],
      ...VALID_INFO.agent.configSource,
    };

    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: {
          ...VALID_INFO.agent,
          model: { routing: { kind: "dynamic", resolver } },
        },
      }).success,
    ).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: { ...VALID_INFO.agent, model: { routing: { kind: "dynamic" } } },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: {
          ...VALID_INFO.agent,
          model: {
            contextWindowTokens: 128_000,
            routing: { kind: "dynamic", resolver },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: {
          ...VALID_INFO.agent,
          model: {
            routing: {
              kind: "dynamic",
              resolver: { ...resolver, eventNames: ["message.delta"] },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { family: "tools", logicalPath: "tools/generated.ts", slot: "tools/generated" },
    { family: "skills", logicalPath: "skills/generated.ts", slot: "skills/generated" },
    {
      family: "instructions",
      logicalPath: "instructions/generated.ts",
      slot: "instructions/generated",
    },
  ] as const)("rejects unsupported $family resolver events", ({ family, logicalPath, slot }) => {
    const resolver = {
      eventNames: ["message.delta"],
      slug: "generated",
      ...moduleSource(logicalPath, `opaque:${family}:generated`),
    };
    const info = withSelectedModules(
      {
        ...VALID_INFO,
        [family]: { dynamic: [resolver], static: [] },
      },
      [[slot, resolver]],
    );

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(false);
  });

  it("preserves the static-or-dynamic local subagent invariant", () => {
    const local = {
      entryPath: "/app/agent/subagents/research",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "opaque:local-node",
      owner: {
        kind: "extension" as const,
        namespace: "crm",
        packageName: "@acme/crm",
      },
      parentNodeId: VALID_INFO.agent.nodeId,
      rootPath: "/app/agent/subagents/research",
      sourceId: "opaque:local-source",
      sourceKind: "subagent" as const,
      summary: {
        channels: 0,
        connections: 0,
        hooks: 0,
        instructions: false,
        schedules: 0,
        skills: 0,
        tools: 0,
      },
    };
    const resolver = {
      eventNames: ["session.started"],
      logicalPath: "subagents/research/agent.ts",
      owner: local.owner,
      sourceId: "opaque:local-config",
      sourceKind: "module" as const,
    };
    const composition = {
      ...VALID_INFO.composition,
      selected: [
        ...VALID_INFO.composition.selected,
        {
          slot: "subagents/research",
          source: {
            logicalPath: local.logicalPath,
            owner: local.owner,
            sourceId: local.sourceId,
            sourceKind: local.sourceKind,
            layer: "extension-package" as const,
          },
          sourceKind: "non-module" as const,
        },
      ],
    };

    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition,
        subagents: { local: [{ ...local, description: "Static" }], total: 1 },
      }).success,
    ).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition,
        subagents: {
          local: [
            {
              ...local,
              configResolver: { ...resolver, eventNames: ["step.started"] },
            },
          ],
          total: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition,
        subagents: { local: [{ ...local, configResolver: resolver }], total: 1 },
      }).success,
    ).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition,
        subagents: { local: [local], total: 1 },
      }).success,
    ).toBe(false);
  });

  it("keeps local and remote counts exact and independent", () => {
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        remoteAgents: { entries: [], total: 1 },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        subagents: { local: [], total: 1 },
      }).success,
    ).toBe(false);
  });

  it("requires a rooted recursive agent graph with sibling-scoped names", () => {
    const rootLocal = {
      description: "Root specialist",
      entryPath: "/app/agent/subagents/research",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "opaque:local:root",
      owner: { kind: "application" as const },
      parentNodeId: VALID_INFO.agent.nodeId,
      rootPath: "/app/agent/subagents/research",
      sourceId: "opaque:local:root-source",
      sourceKind: "subagent" as const,
      summary: emptySubagentSummary(),
    };
    const nestedLocal = {
      ...rootLocal,
      description: "Nested specialist",
      entryPath: "/app/agent/subagents/research/subagents/research",
      logicalPath: "subagents/research/subagents/research",
      nodeId: "opaque:local:nested",
      parentNodeId: rootLocal.nodeId,
      rootPath: "/app/agent/subagents/research/subagents/research",
      sourceId: "opaque:local:nested-source",
    };
    const nestedRemote = {
      configResolver: moduleSource(
        "subagents/research/subagents/remote/agent.ts",
        "opaque:remote:config",
      ),
      description: "Nested remote specialist",
      entryPath: "/app/agent/subagents/research/subagents/remote",
      logicalPath: "subagents/research/subagents/remote",
      name: "remote",
      nodeId: "opaque:remote:nested",
      owner: { kind: "application" as const },
      parentNodeId: rootLocal.nodeId,
      path: "/eve/v1/session",
      rootPath: "/app/agent/subagents/research/subagents/remote",
      sourceId: "opaque:remote:nested-source",
      sourceKind: "subagent" as const,
      url: "https://remote.example",
    };
    const info = {
      ...VALID_INFO,
      composition: {
        ...VALID_INFO.composition,
        selected: [
          ...VALID_INFO.composition.selected,
          {
            slot: "subagents/research",
            source: {
              layer: "application" as const,
              logicalPath: rootLocal.logicalPath,
              owner: rootLocal.owner,
              sourceId: rootLocal.sourceId,
              sourceKind: rootLocal.sourceKind,
            },
            sourceKind: "non-module" as const,
          },
        ],
      },
      remoteAgents: { entries: [nestedRemote], total: 1 },
      subagents: { local: [rootLocal, nestedLocal], total: 2 },
    };

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        subagents: {
          local: [rootLocal, { ...nestedLocal, parentNodeId: "opaque:missing-parent" }],
          total: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        subagents: {
          local: [
            { ...rootLocal, parentNodeId: nestedLocal.nodeId },
            { ...nestedLocal, parentNodeId: rootLocal.nodeId },
          ],
          total: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        remoteAgents: {
          entries: [{ ...nestedRemote, name: nestedLocal.name }],
          total: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        remoteAgents: {
          entries: [{ ...nestedRemote, parentNodeId: nestedRemote.nodeId }],
          total: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        subagents: {
          local: [{ ...rootLocal, nodeId: VALID_INFO.agent.nodeId }, nestedLocal],
          total: 2,
        },
      }).success,
    ).toBe(false);
  });

  it("requires selected config, sandbox, and matching workspace authority", () => {
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: { ...VALID_INFO.agent, configSource: undefined },
      }).success,
    ).toBe(false);
    expect(AgentInfoResultSchema.safeParse({ ...VALID_INFO, sandbox: null }).success).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        workspace: {
          resourceRoot: { logicalPath: "", rootEntries: ["skills"] },
          rootEntries: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields at root and nested boundaries", () => {
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        agent: { ...VALID_INFO.agent, legacyOrigin: "authored" },
      }).success,
    ).toBe(false);
    expect(AgentInfoResultSchema.safeParse({ ...VALID_INFO, workflow: {} }).success).toBe(false);
  });

  it("rejects duplicate active capability identities", () => {
    const tool = {
      description: "Duplicate capability",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      logicalPath: "tools/search.ts",
      name: "search",
      owner: { kind: "application" as const },
      requiresApproval: false,
      sourceId: "opaque:search",
      sourceKind: "module" as const,
    };

    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        tools: { dynamic: [], static: [tool, { ...tool, sourceId: "opaque:other" }] },
      }).success,
    ).toBe(false);
  });

  it("mirrors tool and direct subagent runtime-name collisions", () => {
    const staticTool = {
      description: "Research the request",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      name: "research",
      requiresApproval: false,
      ...moduleSource("tools/research.ts", "opaque:tool:research"),
    };
    const dynamicTool = {
      eventNames: ["session.started"],
      slug: "remote",
      ...moduleSource("tools/remote.ts", "opaque:tool:remote"),
    };
    const local = {
      description: "Research the request",
      entryPath: "/app/agent/subagents/research/agent.ts",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "opaque:local:research",
      owner: { kind: "application" as const },
      parentNodeId: VALID_INFO.agent.nodeId,
      rootPath: "/app/agent/subagents/research",
      sourceId: "opaque:subagent:research",
      sourceKind: "subagent" as const,
      summary: emptySubagentSummary(),
    };
    const remote = {
      configResolver: moduleSource("subagents/remote/agent.ts", "opaque:remote:config"),
      description: "Call the remote agent",
      entryPath: "/app/agent/subagents/remote/agent.ts",
      logicalPath: "subagents/remote",
      name: "remote",
      nodeId: "opaque:remote:node",
      owner: { kind: "application" as const },
      parentNodeId: VALID_INFO.agent.nodeId,
      path: "/eve/v1/session",
      rootPath: "/app/agent/subagents/remote",
      sourceId: "opaque:subagent:remote",
      sourceKind: "subagent" as const,
      url: "https://remote.example",
    };
    const withTools = withSelectedModules(
      {
        ...VALID_INFO,
        remoteAgents: { entries: [remote], total: 1 },
        subagents: { local: [local], total: 1 },
        tools: { dynamic: [dynamicTool], static: [staticTool] },
      },
      [
        ["tools/research", staticTool],
        ["tools/remote", dynamicTool],
      ],
    );
    const info = {
      ...withTools,
      composition: {
        ...withTools.composition,
        selected: [
          ...withTools.composition.selected,
          ...[local, remote].map((entry) => ({
            slot: `subagents/${entry.name}`,
            source: {
              layer: "application" as const,
              logicalPath: entry.logicalPath,
              owner: entry.owner,
              sourceId: entry.sourceId,
              sourceKind: entry.sourceKind,
            },
            sourceKind: "non-module" as const,
          })),
        ],
      },
    };

    const result = AgentInfoResultSchema.safeParse(info);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected runtime capability collisions.");
    expect(
      result.error.issues
        .filter((issue) => issue.message === "Active capability names must be unique.")
        .map((issue) => issue.path),
    ).toEqual([
      ["subagents", "local", 0],
      ["remoteAgents", "entries", 0],
    ]);
  });

  it("rejects duplicate effective channel route identities", () => {
    const channel = {
      logicalPath: "channels/users.ts",
      method: "GET" as const,
      name: "users",
      owner: { kind: "application" as const },
      sourceId: "opaque:users",
      sourceKind: "module" as const,
      urlPath: "/users/:id",
    };

    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        channels: [channel, { ...channel, name: "duplicate", sourceId: "opaque:duplicate" }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate identities across every static and dynamic primitive collection", () => {
    const staticTool = {
      description: "Static tool",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      name: "static-tool",
      requiresApproval: false,
      ...moduleSource("tools/static-tool.ts", "opaque:tool:static"),
    };
    const dynamicTool = {
      eventNames: ["session.started"],
      slug: "dynamic-tool",
      ...moduleSource("tools/dynamic-tool.ts", "opaque:tool:dynamic"),
    };
    const staticSkill = {
      description: "Static skill",
      markdown: "# Static skill",
      name: "static-skill",
      ...moduleSource("skills/static-skill.ts", "opaque:skill:static"),
    };
    const dynamicSkill = {
      eventNames: ["session.started"],
      slug: "dynamic-skill",
      ...moduleSource("skills/dynamic-skill.ts", "opaque:skill:dynamic"),
    };
    const staticInstructions = {
      content: "Static instructions",
      name: "static-instructions",
      role: "system" as const,
      ...moduleSource("instructions/static.ts", "opaque:instructions:static"),
    };
    const dynamicInstructions = {
      eventNames: ["turn.started"],
      slug: "dynamic-instructions",
      ...moduleSource("instructions/dynamic.ts", "opaque:instructions:dynamic"),
    };
    const selected = [
      ["tools/static-tool", staticTool],
      ["tools/dynamic-tool", dynamicTool],
      ["skills/static-skill", staticSkill],
      ["skills/dynamic-skill", dynamicSkill],
      ["instructions/static", staticInstructions],
      ["instructions/dynamic", dynamicInstructions],
    ] as const;
    const info = withSelectedModules(
      {
        ...VALID_INFO,
        instructions: { dynamic: [dynamicInstructions], static: [staticInstructions] },
        skills: { dynamic: [dynamicSkill], static: [staticSkill] },
        tools: { dynamic: [dynamicTool], static: [staticTool] },
      },
      selected,
    );

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        tools: { ...info.tools, dynamic: [{ ...dynamicTool, slug: staticTool.name }] },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        skills: { ...info.skills, dynamic: [{ ...dynamicSkill, slug: staticSkill.name }] },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        instructions: {
          ...info.instructions,
          dynamic: [{ ...dynamicInstructions, slug: staticInstructions.name }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate connection, hook, schedule, and event identities", () => {
    const firstConnection = {
      connectionName: "crm",
      description: "CRM",
      hasApproval: false,
      hasAuthorization: false,
      hasHeaders: false,
      protocol: "mcp" as const,
      url: "https://crm.example/mcp",
      ...moduleSource("connections/crm.ts", "opaque:connection:crm"),
    };
    const secondConnection = {
      ...firstConnection,
      connectionName: "billing",
      url: "https://billing.example/mcp",
      ...moduleSource("connections/billing.ts", "opaque:connection:billing"),
    };
    const firstHook = {
      eventNames: ["session.started", "turn.started"],
      slug: "audit",
      ...moduleSource("hooks/audit.ts", "opaque:hook:audit"),
    };
    const secondHook = {
      eventNames: ["step.started"],
      slug: "metrics",
      ...moduleSource("hooks/metrics.ts", "opaque:hook:metrics"),
    };
    const firstSchedule = {
      cron: "0 * * * *",
      hasRun: true,
      name: "hourly",
      ...moduleSource("schedules/hourly.ts", "opaque:schedule:hourly"),
    };
    const secondSchedule = {
      cron: "0 0 * * *",
      hasRun: true,
      name: "daily",
      ...moduleSource("schedules/daily.ts", "opaque:schedule:daily"),
    };
    const info = withSelectedModules(
      {
        ...VALID_INFO,
        connections: [firstConnection, secondConnection],
        hooks: [firstHook, secondHook],
        schedules: [firstSchedule, secondSchedule],
      },
      [
        ["connections/crm", firstConnection],
        ["connections/billing", secondConnection],
        ["hooks/audit", firstHook],
        ["hooks/metrics", secondHook],
        ["schedules/hourly", firstSchedule],
        ["schedules/daily", secondSchedule],
      ],
    );

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        connections: [firstConnection, { ...secondConnection, connectionName: "crm" }],
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        hooks: [firstHook, { ...secondHook, slug: "audit" }],
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        schedules: [firstSchedule, { ...secondSchedule, name: "hourly" }],
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        hooks: [{ ...firstHook, eventNames: ["session.started", "session.started"] }, secondHook],
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent selected, disabled, and shadowed composition relations", () => {
    const defaultConfig = {
      layer: "framework-default" as const,
      logicalPath: "agent.ts",
      owner: { feature: "default-agent-config", kind: "framework" as const },
      sourceId: "opaque:config:default",
      sourceKind: "module" as const,
    };
    const withShadowedConfig = {
      ...VALID_INFO,
      composition: {
        ...VALID_INFO.composition,
        shadowed: [
          {
            slot: "agent",
            source: defaultConfig,
            winningSourceId: VALID_INFO.agent.configSource.sourceId,
          },
        ],
      },
    };

    expect(AgentInfoResultSchema.safeParse(withShadowedConfig).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition: {
          ...VALID_INFO.composition,
          selected: [
            ...VALID_INFO.composition.selected,
            {
              slot: "agent",
              source: moduleSource("agent-copy.ts", "opaque:config:copy"),
              sourceKind: "module" as const,
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        composition: {
          ...VALID_INFO.composition,
          disabled: [{ slot: "sandbox", source: defaultConfig }],
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...withShadowedConfig,
        composition: {
          ...withShadowedConfig.composition,
          shadowed: [{ ...withShadowedConfig.composition.shadowed[0]!, winningSourceId: "wrong" }],
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...withShadowedConfig,
        composition: {
          ...withShadowedConfig.composition,
          shadowed: [
            ...withShadowedConfig.composition.shadowed,
            {
              slot: "agent",
              source: { ...defaultConfig, sourceId: "opaque:config:other-default" },
              winningSourceId: VALID_INFO.agent.configSource.sourceId,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires every active source to match selected provenance", () => {
    const tool = {
      description: "Search",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      name: "search",
      requiresApproval: false,
      ...moduleSource("tools/search.ts", "opaque:tool:search"),
    };
    const selected = withSelectedModules(
      { ...VALID_INFO, tools: { dynamic: [], static: [tool] } },
      [["tools/search", tool]],
    );

    expect(AgentInfoResultSchema.safeParse(selected).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...VALID_INFO,
        tools: { dynamic: [], static: [tool] },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...selected,
        tools: {
          dynamic: [],
          static: [
            {
              ...tool,
              owner: { feature: "fabricated-owner", kind: "framework" as const },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires active primitives to come from their selected slot family", () => {
    const tool = {
      description: "Search",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      name: "search",
      requiresApproval: false,
      ...moduleSource("tools/search.ts", "opaque:tool:search"),
    };
    const info = withSelectedModules({ ...VALID_INFO, tools: { dynamic: [], static: [tool] } }, [
      ["tools/search", tool],
    ]);
    const mismatchedSelection = info.composition.selected.map((selected) =>
      selected.source.sourceId === tool.sourceId
        ? { ...selected, slot: "connections/search" }
        : selected,
    );

    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        composition: { ...info.composition, selected: mismatchedSelection },
      }).success,
    ).toBe(false);
  });

  it("requires source-backed model provenance to match the config export exactly", () => {
    const alternate = moduleSource("tools/model.ts", "opaque:model:alternate");
    const info = withSelectedModules(
      {
        ...VALID_INFO,
        agent: {
          ...VALID_INFO.agent,
          model: {
            routing: { kind: "dynamic" as const, resolver: { ...alternate, eventNames: [] } },
          },
        },
        tools: {
          dynamic: [
            {
              ...alternate,
              eventNames: [],
              slug: "model",
            },
          ],
          static: [],
        },
      },
      [["tools/model", alternate]],
    );

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(false);
  });

  it("requires every shadowed route to match a distinct effective winner", () => {
    const winner = {
      method: "GET" as const,
      name: "users",
      urlPath: "/users/:id",
      ...moduleSource("channels/users.ts", "opaque:channel:winner"),
    };
    const loser = {
      method: "GET" as const,
      name: "fallback",
      urlPath: "/users/:name",
      ...moduleSource("channels/fallback.ts", "opaque:channel:loser"),
    };
    const shadowed = {
      loser,
      method: "GET" as const,
      pathPattern: "/users/:_",
      winningSourceId: winner.sourceId,
    };
    const info = withSelectedModules(
      {
        ...VALID_INFO,
        channels: [winner],
        composition: {
          ...VALID_INFO.composition,
          routes: { shadowed: [shadowed] },
        },
      },
      [
        ["channels/users", winner],
        ["channels/fallback", loser],
      ],
    );

    expect(AgentInfoResultSchema.safeParse(info).success).toBe(true);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        composition: {
          ...info.composition,
          routes: { shadowed: [{ ...shadowed, winningSourceId: loser.sourceId }] },
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        composition: {
          ...info.composition,
          routes: { shadowed: [{ ...shadowed, pathPattern: "/teams/:_" }] },
        },
      }).success,
    ).toBe(false);
    expect(
      AgentInfoResultSchema.safeParse({
        ...info,
        composition: {
          ...info.composition,
          routes: { shadowed: [shadowed, shadowed] },
        },
      }).success,
    ).toBe(false);
  });
});

function moduleSource(logicalPath: string, sourceId: string) {
  return {
    logicalPath,
    owner: { kind: "application" as const },
    sourceId,
    sourceKind: "module" as const,
  };
}

function emptySubagentSummary() {
  return {
    channels: 0,
    connections: 0,
    hooks: 0,
    instructions: false,
    schedules: 0,
    skills: 0,
    tools: 0,
  };
}

function withSelectedModules<Info extends { readonly composition: typeof VALID_INFO.composition }>(
  info: Info,
  sources: readonly (readonly [slot: string, source: ReturnType<typeof moduleSource>])[],
) {
  return {
    ...info,
    composition: {
      ...info.composition,
      selected: [
        ...info.composition.selected,
        ...sources.map(([slot, source]) => ({
          slot,
          source: {
            logicalPath: source.logicalPath,
            owner: source.owner,
            sourceId: source.sourceId,
            sourceKind: source.sourceKind,
          },
          sourceKind: "module" as const,
        })),
      ],
    },
  };
}
