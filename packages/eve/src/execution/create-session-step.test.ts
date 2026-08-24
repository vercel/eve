import { describe, expect, it, vi } from "vitest";

import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION } from "#execution/session.js";
import { createSessionStep } from "#execution/create-session-step.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

const TestTurnAgent: RuntimeTurnAgent = {
  id: "test-agent",
  instructions: ["You are a test assistant."],
  model: { id: "test-model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

function withRootGraph<T extends { readonly graph?: unknown; readonly resolvedAgent: unknown }>(
  bundle: T,
): never {
  return {
    ...bundle,
    graph: bundle.graph ?? { root: { agent: bundle.resolvedAgent } },
  } as never;
}

describe("createSessionStep", () => {
  it("adds native agent guidance only to a session where agent is advertised", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: { experimental: { subagentPersistentSessions: true } },
          kernelPlan: { prepared: ["agent"] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const root = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:root",
      sessionId: "sess-root",
    });
    const selfDelegated = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:self",
      rootSessionId: "sess-root",
      sessionId: "sess-self",
      subagentDepth: 1,
    });

    expect(root.state.snapshot?.session.agent.system).toContain("Pass `agentId`");
    expect(root.state.snapshot?.session.agent.system).toContain("Tool execution");
    expect(selfDelegated.state.snapshot?.session.agent.system).not.toContain("Pass `agentId`");
    expect(selfDelegated.state.snapshot?.session.agent.system).not.toContain("Tool execution");
  });

  it("adds task_update guidance to a task-owned session system prompt", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        graph: {
          nodesByNodeId: new Map([
            ["__root__", { agent: { kernelPlan: { prepared: ["task_update"] } } }],
            ["subagents/researcher", { agent: { kernelPlan: { prepared: [] } } }],
          ]),
          root: { agent: { kernelPlan: { prepared: ["task_update"] } } },
        },
        nodeId: "subagents/researcher",
        resolvedAgent: {
          config: { experimental: { tasks: true } },
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      nodeId: "subagents/researcher",
      sessionId: "sess-child",
      taskOwned: true,
    });

    expect(state.snapshot?.session.agent.system).toContain("Background task updates");
    expect(state.snapshot?.session.agent.system).toContain("what you are currently doing");
    expect(state.snapshot?.session.state).toBeUndefined();
  });

  it("does not add task_update guidance to a task-owned node without the tool", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        graph: {
          nodesByNodeId: new Map([["__root__", { agent: { kernelPlan: { prepared: [] } } }]]),
          root: { agent: { kernelPlan: { prepared: [] } } },
        },
        resolvedAgent: {
          config: {},
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      sessionId: "sess-child",
      taskOwned: true,
    });

    expect(state.snapshot?.session.agent.system).not.toContain("Background task updates");
  });

  it("defaults root sessions to the root input token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {},
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(
      DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
    );
  });

  it("limits delegated subagent sessions to the inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {},
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 3_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits).toEqual({
      maxInputTokensPerSession: 3_000_000,
    });
  });

  it("leaves delegated subagent sessions uncapped with uncapped inherited axes", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {},
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: false, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits).toEqual({});
  });

  it("caps configured child token limits at the inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {
            limits: { maxInputTokensPerSession: 10_000_000 },
          },
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 2_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(2_000_000);
  });

  it("keeps tighter configured child token limits under inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {
            limits: { maxInputTokensPerSession: 1_000_000 },
          },
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 2_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(1_000_000);
  });

  it("still applies inherited token budget when configured child limit is false", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {
            limits: { maxInputTokensPerSession: false },
          },
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(500_000);
  });

  it("seeds session token limits from resolved agent config", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {
            limits: {
              maxInputTokensPerSession: 200_000,
              maxOutputTokensPerSession: 20_000,
            },
          },
          kernelPlan: { prepared: [] },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.limits).toMatchObject({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
  });

  it("seeds workflow max subagents from the authored Workflow tool", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(
      withRootGraph({
        resolvedAgent: {
          config: {},
          kernelPlan: { prepared: [] },
          workflowTool: { maxSubagents: 5 },
        },
        turnAgent: TestTurnAgent,
      }),
    );

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.workflowMaxSubagents).toBe(5);
  });
});
