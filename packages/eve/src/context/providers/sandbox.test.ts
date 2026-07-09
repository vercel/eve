import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import {
  InheritedSandboxKey,
  SandboxKey,
  SandboxOwnerDynamicSkillNamesKey,
  SandboxOwnerStaticSkillNamesKey,
  SessionIdKey,
  SessionKey,
  StaticSkillNamesKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { ContextContainer, loadContext } from "#context/container.js";
import { sandboxProvider } from "#context/providers/sandbox.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";

vi.mock("../../execution/sandbox/ensure.js", () => ({
  ensureSandboxAccess: vi.fn(),
}));

function createHarnessSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "openai/gpt-5.4" },
      system: "",
      tools: [],
    },
    compaction: {
      recentWindowSize: 0,
      threshold: 0,
    },
    continuationToken: "",
    history: [],
    sessionId: "session_1",
  };
}

function createBundle(input: {
  readonly agentName: string;
  readonly extraNodes?: readonly {
    readonly agentName: string;
    readonly nodeId: string;
    readonly registry: RuntimeSandboxRegistry;
    readonly skillNames?: readonly string[];
    readonly workspaceResourceRoot?: ResolvedRuntimeAgentNode["agent"]["workspaceResourceRoot"];
  }[];
  readonly parent?: {
    readonly agentName: string;
    readonly nodeId: string;
    readonly registry: RuntimeSandboxRegistry;
    readonly skillNames?: readonly string[];
    readonly workspaceResourceRoot?: ResolvedRuntimeAgentNode["agent"]["workspaceResourceRoot"];
  };
  readonly registry: RuntimeSandboxRegistry;
  readonly skillNames?: readonly string[];
  readonly workspaceResourceRoot?: ResolvedRuntimeAgentNode["agent"]["workspaceResourceRoot"];
}): CompiledBundle {
  const root = createRuntimeNode({
    agentName: input.agentName,
    nodeId: "__root__",
    registry: input.registry,
    skillNames: input.skillNames,
    workspaceResourceRoot: input.workspaceResourceRoot,
  });
  const nodesByNodeId = new Map([[root.nodeId, root]]);
  if (input.parent !== undefined) {
    nodesByNodeId.set(
      input.parent.nodeId,
      createRuntimeNode({
        agentName: input.parent.agentName,
        nodeId: input.parent.nodeId,
        registry: input.parent.registry,
        skillNames: input.parent.skillNames,
        workspaceResourceRoot: input.parent.workspaceResourceRoot,
      }),
    );
  }
  for (const node of input.extraNodes ?? []) {
    nodesByNodeId.set(
      node.nodeId,
      createRuntimeNode({
        agentName: node.agentName,
        nodeId: node.nodeId,
        registry: node.registry,
        skillNames: node.skillNames,
        workspaceResourceRoot: node.workspaceResourceRoot,
      }),
    );
  }
  const adapterRegistry = { adaptersByKind: new Map() };
  const hookRegistry = { streamEventsByType: new Map(), streamEventsWildcard: [] };
  const subagentRegistry = {
    preparedTools: [],
    subagentsByName: new Map(),
    subagentsByNodeId: new Map(),
  };
  const toolRegistry = { preparedTools: [], toolsByName: new Map() };
  return {
    adapterRegistry,
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    graph: {
      nodesByNodeId,
      root,
    },
    hookRegistry,
    moduleMap: { nodes: {} },
    resolvedAgent: root.agent,
    subagentRegistry,
    toolRegistry,
    turnAgent: root.turnAgent,
  };
}

function createRuntimeNode(input: {
  readonly agentName: string;
  readonly nodeId: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly skillNames?: readonly string[];
  readonly workspaceResourceRoot?: ResolvedRuntimeAgentNode["agent"]["workspaceResourceRoot"];
}): ResolvedRuntimeAgentNode {
  const model = { id: "openai/gpt-5.4" };
  const agent = {
    channels: [],
    config: {
      model,
      name: input.agentName,
    },
    connections: [],
    disabledFrameworkChannels: [],
    disabledFrameworkTools: [],
    dynamicInstructionsResolvers: [],
    dynamicSkillResolvers: [],
    dynamicToolResolvers: [],
    hooks: [],
    metadata: {
      agentRoot: "/app/agent",
      appRoot: "/app",
      diagnosticsSummary: { errors: 0, warnings: 0 },
    },
    sandbox: null,
    skills: (input.skillNames ?? []).map((name) => ({ name })) as never,
    tools: [],
    workflowEnabled: false,
    workspaceResourceRoot:
      input.workspaceResourceRoot ??
      input.registry.sandbox.workspaceResourceRoots[0] ??
      input.registry.sandbox.workspaceResourceRoot,
    workspaceSpec: { rootEntries: [] },
  };
  return {
    agent,
    channels: [],
    hookRegistry: { streamEventsByType: new Map(), streamEventsWildcard: [] },
    nodeId: input.nodeId,
    sandboxRegistry: input.registry,
    subagentRegistry: {
      preparedTools: [],
      subagentsByName: new Map(),
      subagentsByNodeId: new Map(),
    },
    toolRegistry: { preparedTools: [], toolsByName: new Map() },
    turnAgent: {
      id: input.agentName,
      instructions: [],
      model,
      nodeId: input.nodeId,
      tools: [],
      workspaceSpec: { rootEntries: [] },
    },
  };
}

function createRegistryWithRoots(
  roots: readonly ResolvedRuntimeAgentNode["agent"]["workspaceResourceRoot"][],
): RuntimeSandboxRegistry {
  const base = createStubSandboxRegistry();
  return {
    sandbox: {
      ...base.sandbox,
      workspaceResourceRoot: roots[0] ?? base.sandbox.workspaceResourceRoot,
      workspaceResourceRoots: roots,
    },
  };
}

describe("sandboxProvider", () => {
  beforeEach(() => {
    vi.mocked(ensureSandboxAccess).mockResolvedValue({
      captureState: vi.fn().mockResolvedValue({ initialized: false, session: null }),
      get: vi.fn().mockResolvedValue(null),
    });
  });

  it("tags sandbox backend resources with agent, channel, and session id", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, { kind: "slack" });
    ctx.set(SessionIdKey, "session_1");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          agent: "weather-agent",
          channel: "slack",
          sessionId: "session_1",
        },
      }),
    );
  });

  it("uses an inherited sandbox node and parent session from subagent adapter state", async () => {
    const ctx = new ContextContainer();
    const childRegistry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const parentRegistry: RuntimeSandboxRegistry = createStubSandboxRegistry();

    ctx.set(
      BundleKey,
      createBundle({
        agentName: "reviewer",
        parent: {
          agentName: "researcher",
          nodeId: "subagents/researcher",
          registry: parentRegistry,
        },
        registry: childRegistry,
      }),
    );
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: {
        sandboxOwnerDynamicSkillNames: ["parent-dynamic"],
        sandboxNodeId: "subagents/researcher",
        sandboxSessionId: "parent-session",
      },
    });
    ctx.set(SessionIdKey, "child-session");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "subagents/researcher",
        registry: parentRegistry,
        sessionId: "parent-session",
        tags: {
          agent: "researcher",
          channel: "subagent",
          sessionId: "child-session",
        },
      }),
    );
  });

  it("runs inherited sandbox session hooks inside the sandbox owner context", async () => {
    const ctx = new ContextContainer();
    const childRoot = {
      logicalPath: "workspace-resources/subagents/reviewer",
      rootEntries: [],
    };
    const parentRoot = {
      logicalPath: "workspace-resources/subagents/researcher",
      rootEntries: [],
    };
    const childRegistry: RuntimeSandboxRegistry = createRegistryWithRoots([childRoot]);
    const parentRegistry: RuntimeSandboxRegistry = createRegistryWithRoots([parentRoot]);
    const liveSandbox = { id: "parent-sandbox" };

    ctx.set(
      BundleKey,
      createBundle({
        agentName: "reviewer",
        parent: {
          agentName: "researcher",
          nodeId: "subagents/researcher",
          registry: parentRegistry,
          skillNames: ["parent-skill"],
          workspaceResourceRoot: parentRoot,
        },
        registry: childRegistry,
        skillNames: ["child-skill"],
        workspaceResourceRoot: childRoot,
      }),
    );
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: {
        sandboxOwnerDynamicSkillNames: ["parent-dynamic"],
        sandboxNodeId: "subagents/researcher",
        sandboxSessionId: "parent-session",
      },
    });
    ctx.set(SessionIdKey, "child-session");
    ctx.setVirtualContext(SessionKey, {
      auth: { current: null, initiator: null },
      parent: {
        callId: "call-1",
        rootSessionId: "parent-session",
        sessionId: "parent-session",
        turn: { id: "parent-turn", sequence: 4 },
      },
      sessionId: "child-session",
      turn: { id: "child-turn", sequence: 1 },
    });

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ctx.require(InheritedSandboxKey)).toBe(true);
    expect(ctx.require(SandboxOwnerDynamicSkillNamesKey)).toEqual(["parent-dynamic"]);
    expect(ctx.require(SandboxOwnerStaticSkillNamesKey)).toEqual(["parent-skill"]);

    const runOnSession = vi.mocked(ensureSandboxAccess).mock.calls.at(-1)?.[0].runOnSession;
    if (runOnSession === undefined) throw new Error("runOnSession was not passed");

    let observed:
      | {
          nodeId: string;
          parent: unknown;
          sandbox: unknown;
          sessionId: string;
          sessionSeed: string;
          skillNames: readonly string[];
          turn: { id: string; sequence: number };
        }
      | undefined;

    await runOnSession(
      async () => {
        const active = loadContext();
        const session = active.require(SessionKey);
        observed = {
          nodeId: active.require(BundleKey).graph.root.nodeId,
          parent: session.parent,
          sandbox: await active.require(SandboxKey).get(),
          sessionId: session.sessionId,
          sessionSeed: active.require(SessionIdKey),
          skillNames: active.require(StaticSkillNamesKey),
          turn: session.turn,
        };
      },
      {
        captureState: async () => ({ backendName: "test", metadata: {}, sessionKey: "parent" }),
        session: liveSandbox,
        shutdown: async () => {},
        useSessionFn: async () => liveSandbox,
      } as never,
    );

    expect(observed).toEqual({
      nodeId: "subagents/researcher",
      parent: undefined,
      sandbox: liveSandbox,
      sessionId: "parent-session",
      sessionSeed: "parent-session",
      skillNames: ["parent-skill"],
      turn: { id: "parent-turn", sequence: 4 },
    });
  });

  it("tracks every static skill seeded into an inherited sandbox", async () => {
    const ctx = new ContextContainer();
    const parentRoot = {
      logicalPath: "workspace-resources/subagents/researcher",
      rootEntries: [],
    };
    const auditorRoot = {
      logicalPath: "workspace-resources/subagents/researcher::subagents/auditor",
      rootEntries: [],
    };
    const childRegistry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const parentRegistry: RuntimeSandboxRegistry = createRegistryWithRoots([
      parentRoot,
      auditorRoot,
    ]);

    ctx.set(
      BundleKey,
      createBundle({
        agentName: "reviewer",
        extraNodes: [
          {
            agentName: "auditor",
            nodeId: "subagents/researcher/subagents/auditor",
            registry: createStubSandboxRegistry(),
            skillNames: ["auditor-skill"],
            workspaceResourceRoot: auditorRoot,
          },
        ],
        parent: {
          agentName: "researcher",
          nodeId: "subagents/researcher",
          registry: parentRegistry,
          skillNames: ["parent-skill"],
          workspaceResourceRoot: parentRoot,
        },
        registry: childRegistry,
      }),
    );
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: {
        sandboxNodeId: "subagents/researcher",
        sandboxSessionId: "parent-session",
      },
    });
    ctx.set(SessionIdKey, "child-session");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ctx.require(SandboxOwnerStaticSkillNamesKey)).toEqual(["auditor-skill", "parent-skill"]);
  });
});
