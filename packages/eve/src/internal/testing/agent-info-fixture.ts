import type { AgentInfoResult } from "#client/types.js";

export function createTestAgentInfoResult(
  input: {
    readonly agentRoot?: string;
    readonly appRoot?: string;
    readonly modelId?: string;
    readonly name?: string;
  } = {},
): AgentInfoResult {
  const agentRoot = input.agentRoot ?? "/tmp/test-agent/agent";
  const appRoot = input.appRoot ?? "/tmp/test-agent";
  const owner = { kind: "application" as const };
  const configBinding = {
    backing: {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: `${agentRoot}/agent.ts`,
    },
    logicalPath: "agent.ts",
    owner,
  };
  return {
    agent: {
      agentRoot,
      appRoot,
      config: {
        binding: configBinding,
        logicalPath: "agent.ts",
        owner,
        sourceId: "agent.ts",
        sourceKind: "module",
      },
      model: {
        id: input.modelId ?? "openai/gpt-5.5",
        routing: { kind: "gateway", target: "openai" },
      },
      name: input.name ?? "Test Agent",
      nodeId: "__root__",
    },
    capabilities: { devRoutes: true },
    channels: { routes: [], shadowed: [] },
    composition: { disabled: [], shadowed: [] },
    connections: [],
    diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
    hooks: [],
    instructions: { dynamic: [], static: [] },
    kernelEffects: [],
    kind: "eve-agent-info",
    mode: "development",
    remoteAgents: { entries: [], total: 0 },
    sandbox: {
      binding: {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `${agentRoot}/sandbox.ts`,
        },
        logicalPath: "sandbox.ts",
        owner,
      },
      hasBootstrap: false,
      hasOnSession: false,
      logicalPath: "sandbox.ts",
      owner,
      sourceId: "sandbox.ts",
      sourceKind: "module",
    },
    schedules: [],
    skills: { dynamic: [], static: [] },
    subagents: { local: [], total: 0 },
    tools: { dynamic: [], static: [] },
    version: 3,
    workflow: { enabled: false, toolName: "Workflow" },
    workspace: { resourceRoot: null, rootEntries: [] },
  };
}
