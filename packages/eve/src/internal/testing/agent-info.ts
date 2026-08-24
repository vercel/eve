import type { AgentInfoResult } from "#client/agent-info-schema.js";

type TestAgentInfoOverrides = Omit<Partial<AgentInfoResult>, "agent"> & {
  readonly agent?: Partial<AgentInfoResult["agent"]>;
};

/** Creates a complete strict v3 payload for client and TUI tests. */
export function createTestAgentInfoResult(overrides: TestAgentInfoOverrides = {}): AgentInfoResult {
  const configSource = {
    logicalPath: "agent.ts",
    owner: { kind: "application" as const },
    sourceId: "test:agent-config",
    sourceKind: "module" as const,
  };
  const sandboxSource = {
    logicalPath: "sandbox.ts",
    owner: { feature: "default-sandbox", kind: "framework" as const },
    sourceId: "test:sandbox",
    sourceKind: "module" as const,
  };
  const sandbox = {
    ...sandboxSource,
    hasBootstrap: false,
    hasOnSession: false,
    sourceHash: "test-sandbox",
  };
  const base: AgentInfoResult = {
    agent: {
      agentRoot: "/tmp/test-agent/agent",
      appRoot: "/tmp/test-agent",
      configSource,
      model: { id: "openai/gpt-5.5", routing: { kind: "gateway", target: "openai" } },
      name: "Test Agent",
      nodeId: "__root__",
    },
    capabilities: { devRoutes: true },
    channels: [],
    composition: {
      disabled: [],
      routes: { shadowed: [] },
      selected: [
        { slot: "agent", source: configSource, sourceKind: "module" },
        { slot: "sandbox", source: sandboxSource, sourceKind: "module" },
      ],
      shadowed: [],
    },
    connections: [],
    diagnostics: { errors: 0, warnings: 0 },
    hooks: [],
    instructions: { dynamic: [], static: [] },
    kernel: {
      availability: "prepared-potential",
      frameworkSources: [],
      native: [],
    },
    kind: "eve-agent-info",
    mode: "development",
    remoteAgents: { entries: [], total: 0 },
    sandbox,
    schedules: [],
    skills: { dynamic: [], static: [] },
    subagents: { local: [], total: 0 },
    tools: { dynamic: [], static: [] },
    version: 3,
    workspace: {
      resourceRoot: { logicalPath: "", rootEntries: [] },
      rootEntries: [],
    },
  };

  return {
    ...base,
    ...overrides,
    agent: { ...base.agent, ...overrides.agent },
  };
}
