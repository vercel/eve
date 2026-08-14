import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import {
  getCompiledRuntimeAgentBundle,
  type CompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import type { ResolvedAgent, ResolvedChannelDefinition } from "#runtime/types.js";
import {
  createNitroWorkflowRuntimeStack,
  resolveNitroChannelRuntimeBundle,
} from "#internal/nitro/routes/runtime-stack.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { WORKFLOW_QUEUE_NAMESPACE_ENV } from "#internal/workflow/queue-namespace.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: vi.fn(),
}));

const compiledArtifactsSource = {
  appRoot: "/app/agent",
  kind: "disk",
} satisfies RuntimeCompiledArtifactsSource;
const runtime = {} as Runtime;
const mockedCreateWorkflowRuntime = vi.mocked(createWorkflowRuntime);
const mockedGetCompiledRuntimeAgentBundle = vi.mocked(getCompiledRuntimeAgentBundle);
const mockedResolveNitroCompiledArtifactsSource = vi.mocked(resolveNitroCompiledArtifactsSource);

function createBundle(input?: {
  readonly agentName?: string;
  readonly channels?: readonly ResolvedChannelDefinition[];
}): CompiledRuntimeAgentBundle {
  const agentName = input?.agentName ?? "teams-agent";
  const hookRegistry = createEmptyHookRegistry();
  const subagentRegistry: RuntimeSubagentRegistry = {
    preparedTools: [],
    subagentsByName: new Map(),
    subagentsByNodeId: new Map(),
  };
  const toolRegistry: RuntimeToolRegistry = {
    preparedTools: [],
    toolsByName: new Map(),
  };
  const agent = {
    config: {
      name: agentName,
    },
  } as ResolvedAgent;
  const turnAgent: RuntimeTurnAgent = {
    id: agentName,
    instructions: [],
    model: { id: "openai/gpt-5.4" } as RuntimeTurnAgent["model"],
    tools: [],
    workspaceSpec: {} as RuntimeTurnAgent["workspaceSpec"],
  };
  const root = {
    agent,
    channels: input?.channels ?? [],
    hookRegistry,
    nodeId: "__root__",
    sandboxRegistry: {} as RuntimeSandboxRegistry,
    subagentRegistry,
    toolRegistry,
    turnAgent,
  } satisfies ResolvedRuntimeAgentNode;

  return {
    adapterRegistry: { adaptersByKind: new Map() } satisfies RuntimeAdapterRegistry,
    compiledArtifactsSource,
    graph: {
      nodesByNodeId: new Map([[root.nodeId, root]]),
      root,
    },
    hookRegistry,
    moduleMap: {} as CompiledModuleMap,
    resolvedAgent: agent,
    subagentRegistry,
    toolRegistry,
    turnAgent,
  };
}

describe("Nitro runtime stack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedCreateWorkflowRuntime.mockReturnValue(runtime);
    mockedResolveNitroCompiledArtifactsSource.mockReturnValue(compiledArtifactsSource);
  });

  it("installs the agent-scoped workflow queue namespace before creating the runtime", async () => {
    const bundle = createBundle({ agentName: "teams-agent" });
    mockedGetCompiledRuntimeAgentBundle.mockResolvedValue(bundle);
    vi.stubEnv(WORKFLOW_QUEUE_NAMESPACE_ENV, undefined);
    mockedCreateWorkflowRuntime.mockImplementation(() => {
      expect(process.env[WORKFLOW_QUEUE_NAMESPACE_ENV]).toBe("eve7465616d732d6167656e74");
      return runtime;
    });

    const stack = await createNitroWorkflowRuntimeStack(compiledArtifactsSource);

    expect(stack).toEqual({ bundle, runtime });
    expect(mockedGetCompiledRuntimeAgentBundle).toHaveBeenCalledWith({ compiledArtifactsSource });
    expect(process.env[WORKFLOW_QUEUE_NAMESPACE_ENV]).toBe("eve7465616d732d6167656e74");
    expect(mockedCreateWorkflowRuntime).toHaveBeenCalledWith({ compiledArtifactsSource });
  });

  it("returns resolved channels with a runtime using the same installed namespace", async () => {
    const channels = [
      {
        fetch: async () => new Response("ok"),
        logicalPath: "agent/channels/teams.ts",
        method: "POST",
        name: "teams",
        sourceId: "channel-teams",
        sourceKind: "module",
        urlPath: "/eve/v1/teams",
      } satisfies ResolvedChannelDefinition,
    ];
    mockedGetCompiledRuntimeAgentBundle.mockResolvedValue(
      createBundle({ agentName: "support-agent", channels }),
    );

    const bundle = await resolveNitroChannelRuntimeBundle({ appRoot: "/app/agent" });

    expect(mockedResolveNitroCompiledArtifactsSource).toHaveBeenCalledWith({
      appRoot: "/app/agent",
    });
    expect(bundle).toEqual({ channels, runtime });
    expect(process.env[WORKFLOW_QUEUE_NAMESPACE_ENV]).toBe("eve737570706f72742d6167656e74");
  });
});
