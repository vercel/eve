import type { AgentInfoResult } from "#client/types.js";

export function createTestAgentInfoResult(
  input: {
    readonly modelId?: string;
    readonly name?: string;
  } = {},
): AgentInfoResult {
  const owner = { kind: "application" as const };
  const configBinding = {
    backing: {
      externalDependencies: [],
      kind: "filesystem" as const,
    },
    logicalPath: "agent.ts",
    owner,
  };
  return {
    agent: {
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
    memories: [],
    mode: "development",
    remoteAgents: { entries: [], total: 0 },
    sandbox: {
      binding: {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
        },
        logicalPath: "sandbox.ts",
        owner,
      },
      environmentExportName: "environment",
      logicalPath: "sandbox.ts",
      owner,
      revisionHash: "sandbox-revision",
      sourceId: "sandbox.ts",
      sourceKind: "module",
    },
    schedules: [],
    skills: { dynamic: [], static: [] },
    subagents: { local: [], total: 0 },
    tools: { dynamic: [], static: [] },
    version: 6,
    workspace: { resourceRoot: null, rootEntries: [] },
  };
}
