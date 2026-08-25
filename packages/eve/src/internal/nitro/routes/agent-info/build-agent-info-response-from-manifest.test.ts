import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledSandboxDefinition,
  type CompiledToolDefinition,
  type CreateCompiledAgentResourcesInput,
} from "#compiler/manifest.js";
import type { AgentSourceOwner, CompiledModuleBinding } from "#compiler/source-graph.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js";

const APPLICATION: AgentSourceOwner = { kind: "application" };
const FRAMEWORK: AgentSourceOwner = { feature: "defaults", kind: "framework" };

const DISCONNECTED_GATEWAY = { apiKey: false, oidc: false } as const;

function binding(logicalPath: string, owner: AgentSourceOwner): CompiledModuleBinding {
  return {
    backing: {
      externalDependencies: [],
      kind: "filesystem",
      sourcePath: `/app/agent/${logicalPath}`,
    },
    logicalPath,
    owner,
  };
}

function tool(name: string): CompiledToolDefinition {
  return {
    description: `${name} tool`,
    inputSchema: null,
    logicalPath: `tools/${name}.ts`,
    name,
    sourceId: `tools/${name}.ts`,
    sourceKind: "module",
  };
}

const SANDBOX: CompiledSandboxDefinition = {
  backendName: "local",
  logicalPath: "sandbox.ts",
  sourceHash: "sandbox-hash",
  sourceId: "sandbox.ts",
  sourceKind: "module",
};

function makeManifest(
  input: Partial<
    CreateCompiledAgentResourcesInput &
      Pick<CompiledAgentManifest, "channelRoutes" | "config" | "subagentEdges" | "subagents">
  > = {},
): CompiledAgentManifest {
  return createCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    ...input,
    bindings: {
      "agent.ts": binding("agent.ts", FRAMEWORK),
      "sandbox.ts": binding("sandbox.ts", FRAMEWORK),
      ...input.bindings,
    },
    channelRoutes: input.channelRoutes ?? { effective: [], preflight: [], shadowed: [] },
    config: input.config ?? {
      model: {
        id: "openai/gpt-5",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "app",
      source: { logicalPath: "agent.ts", sourceId: "agent.ts", sourceKind: "module" },
    },
    sandbox: SANDBOX,
    sourceComposition: input.sourceComposition ?? { disabled: [], shadowed: [] },
  });
}

describe("buildAgentInfoResponse", () => {
  it("groups active tools by owner and projects framework kernel slots separately", () => {
    const manifest = makeManifest({
      bindings: {
        "tools/agent.ts": binding("tools/agent.ts", FRAMEWORK),
        "tools/ask_question.ts": binding("tools/ask_question.ts", FRAMEWORK),
        "tools/bash.ts": binding("tools/bash.ts", FRAMEWORK),
        "tools/get_weather.ts": binding("tools/get_weather.ts", APPLICATION),
        "tools/task_cancel.ts": binding("tools/task_cancel.ts", FRAMEWORK),
        "tools/task_update.ts": binding("tools/task_update.ts", FRAMEWORK),
        "tools/web_search.ts": binding("tools/web_search.ts", FRAMEWORK),
      },
      tools: [
        tool("agent"),
        tool("ask_question"),
        tool("bash"),
        tool("get_weather"),
        tool("task_cancel"),
        tool("task_update"),
        tool("web_search"),
      ],
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.tools.entries.map((entry) => [entry.name, entry.source.owner])).toEqual([
      ["bash", "framework"],
      ["get_weather", "application"],
    ]);
    expect(result.kernel.prepared).toEqual([
      {
        action: "subagent-call",
        kind: "dispatch",
        source: { logicalPath: "tools/agent.ts", owner: "framework", sourceId: "tools/agent.ts" },
        toolName: "agent",
      },
      {
        action: undefined,
        kind: "request-input",
        source: {
          logicalPath: "tools/ask_question.ts",
          owner: "framework",
          sourceId: "tools/ask_question.ts",
        },
        toolName: "ask_question",
      },
      {
        action: "task-cancel",
        kind: "dispatch",
        source: {
          logicalPath: "tools/task_cancel.ts",
          owner: "framework",
          sourceId: "tools/task_cancel.ts",
        },
        toolName: "task_cancel",
      },
      {
        action: "task-update",
        kind: "dispatch",
        source: {
          logicalPath: "tools/task_update.ts",
          owner: "framework",
          sourceId: "tools/task_update.ts",
        },
        toolName: "task_update",
      },
      {
        action: undefined,
        kind: "provider-tool",
        source: {
          logicalPath: "tools/web_search.ts",
          owner: "framework",
          sourceId: "tools/web_search.ts",
        },
        toolName: "web_search",
      },
    ]);

    const parsed = AgentInfoResultSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("keeps an application-owned tool named after a kernel slot as an ordinary tool", () => {
    const manifest = makeManifest({
      bindings: {
        "tools/ask_question.ts": binding("tools/ask_question.ts", APPLICATION),
      },
      tools: [tool("ask_question")],
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.kernel.prepared).toEqual([]);
    expect(result.tools.entries.map((entry) => [entry.name, entry.source.owner])).toEqual([
      ["ask_question", "application"],
    ]);
  });

  it("projects the compiled channel route plan in mount order", () => {
    const manifest = makeManifest({
      bindings: {
        "channels/eve.ts": binding("channels/eve.ts", FRAMEWORK),
        "channels/slack.ts": binding("channels/slack.ts", APPLICATION),
      },
      channelRoutes: {
        effective: [
          {
            adapterKind: "slack",
            kind: "channel",
            logicalPath: "channels/slack.ts",
            method: "POST",
            name: "slack",
            sourceId: "channels/slack.ts",
            sourceKind: "module",
            urlPath: "/slack",
          },
          {
            kind: "channel",
            logicalPath: "channels/eve.ts",
            method: "POST",
            name: "eve",
            sourceId: "channels/eve.ts",
            sourceKind: "module",
            urlPath: "/eve/v1/session",
          },
        ],
        preflight: [],
        shadowed: [
          {
            loser: {
              layer: "framework-default",
              logicalPath: "channels/home.ts",
              name: "home",
              owner: FRAMEWORK,
              sourceId: "eve-root:channels/home.ts",
            },
            method: "GET",
            urlPath: "/",
            winningSourceId: "channels/slack.ts",
          },
        ],
      },
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.channels.total).toBe(2);
    expect(result.channels.routes).toEqual([
      {
        adapterKind: "slack",
        channelName: "slack",
        method: "POST",
        path: "/slack",
        source: {
          logicalPath: "channels/slack.ts",
          owner: "application",
          sourceId: "channels/slack.ts",
        },
      },
      {
        adapterKind: undefined,
        channelName: "eve",
        method: "POST",
        path: "/eve/v1/session",
        source: { logicalPath: "channels/eve.ts", owner: "framework", sourceId: "channels/eve.ts" },
      },
    ]);
    expect(result.channels.shadowed).toEqual([
      {
        adapterKind: undefined,
        channelName: "home",
        method: "GET",
        path: "/",
        source: {
          logicalPath: "channels/home.ts",
          owner: "framework",
          sourceId: "eve-root:channels/home.ts",
        },
        winningSourceId: "channels/slack.ts",
      },
    ]);
  });

  it("summarizes per-node composition diagnostics with node ids", () => {
    const manifest = makeManifest({
      sourceComposition: {
        disabled: [
          {
            disabledBy: {
              layer: "application",
              logicalPath: "tools/agent.ts",
              owner: APPLICATION,
              sourceId: "tools/agent.ts",
            },
            slot: "tools/agent",
          },
        ],
        shadowed: [
          {
            loser: {
              layer: "framework-default",
              logicalPath: "tools/bash.ts",
              owner: FRAMEWORK,
              sourceId: "eve:tools/bash.ts",
            },
            slot: "tools/bash",
            winningSourceId: "tools/bash.ts",
          },
        ],
      },
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.composition).toEqual({
      disabled: [
        {
          logicalPath: "tools/agent.ts",
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          owner: "application",
          slot: "tools/agent",
        },
      ],
      shadowed: [
        {
          logicalPath: "tools/bash.ts",
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          owner: "framework",
          slot: "tools/bash",
          winningSourceId: "tools/bash.ts",
        },
      ],
    });
  });

  it("projects local subagents with parent edges and remote agents per declaring node", () => {
    const subagentResources = createCompiledAgentNodeManifest({
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      // A real authored subagent always carries an authored agent.ts, so the
      // child's config binding is application-owned; subagent ownership in
      // the projection derives from exactly this binding.
      bindings: {
        "agent.ts": binding("agent.ts", APPLICATION),
        "sandbox.ts": binding("sandbox.ts", FRAMEWORK),
      },
      config: {
        model: { id: "openai/gpt-5", routing: { kind: "gateway", target: "openai" } },
        name: "research",
        source: { logicalPath: "agent.ts", sourceId: "agent.ts", sourceKind: "module" },
      },
      sandbox: SANDBOX,
      sourceComposition: { disabled: [], shadowed: [] },
    });
    const manifest = makeManifest({
      bindings: {
        "remote-agents/support.ts": binding("remote-agents/support.ts", APPLICATION),
      },
      remoteAgents: [
        {
          description: "Remote support agent.",
          entryPath: "remote-agents/support.ts",
          logicalPath: "remote-agents/support.ts",
          name: "support",
          nodeId: "remote:support",
          path: "remote-agents/support.ts",
          rootPath: "remote-agents",
          sourceId: "remote-agents/support.ts",
          sourceKind: "module",
          url: "https://support.example.com",
        },
      ],
      subagentEdges: [{ childNodeId: "research", parentNodeId: ROOT_COMPILED_AGENT_NODE_ID }],
      subagents: [
        {
          agent: subagentResources,
          description: "Research subagent.",
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          name: "research",
          nodeId: "research",
          rootPath: "subagents/research",
          sourceId: "subagents/research/agent.ts",
          sourceKind: "module",
        },
      ],
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.subagents).toEqual({
      local: [
        {
          configResolver: undefined,
          description: "Research subagent.",
          name: "research",
          nodeId: "research",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
          source: {
            logicalPath: "subagents/research",
            owner: "application",
            sourceId: "subagents/research/agent.ts",
          },
        },
      ],
      total: 1,
    });
    expect(result.remoteAgents).toEqual({
      entries: [
        {
          description: "Remote support agent.",
          name: "support",
          nodeId: "remote:support",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
          source: {
            logicalPath: "remote-agents/support.ts",
            owner: "application",
            sourceId: "remote-agents/support.ts",
          },
          url: "https://support.example.com",
        },
      ],
      total: 1,
    });

    const parsed = AgentInfoResultSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("reports a static model with its endpoint status and binding provenance", () => {
    const manifest = makeManifest();

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.agent.nodeId).toBe(ROOT_COMPILED_AGENT_NODE_ID);
    expect(result.agent.config.source).toEqual({
      logicalPath: "agent.ts",
      owner: "framework",
      sourceId: "agent.ts",
    });
    expect(result.agent.model).toMatchObject({
      endpoint: { connected: false, kind: "gateway" },
      id: "openai/gpt-5",
      routing: { kind: "static" },
    });
    expect(result.sandbox).toEqual({
      backendName: "local",
      description: undefined,
      source: { logicalPath: "sandbox.ts", owner: "framework", sourceId: "sandbox.ts" },
    });

    const parsed = AgentInfoResultSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("reports a dynamic model as a resolver without a model id", () => {
    const manifest = makeManifest({
      config: {
        dynamicModel: {
          eventNames: ["turn.started"],
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
        name: "app",
        source: { logicalPath: "agent.ts", sourceId: "agent.ts", sourceKind: "module" },
      },
    });

    const result = buildAgentInfoResponse(manifest, {
      gatewayCredentials: DISCONNECTED_GATEWAY,
      mode: "development",
    });

    expect(result.agent.model).toEqual({
      reasoning: undefined,
      routing: {
        kind: "dynamic",
        resolver: {
          events: ["turn.started"],
          logicalPath: "agent.ts",
          owner: "framework",
          slug: undefined,
          sourceId: "agent.ts",
        },
      },
    });
    expect("id" in result.agent.model).toBe(false);

    const parsed = AgentInfoResultSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("throws when a module-backed record has no binding instead of defaulting ownership", () => {
    const manifest = makeManifest({
      tools: [tool("get_weather")],
    });

    expect(() =>
      buildAgentInfoResponse(manifest, {
        gatewayCredentials: DISCONNECTED_GATEWAY,
        mode: "development",
      }),
    ).toThrow(/no binding for source "tools\/get_weather\.ts"/);
  });
});
