import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { startRemoteSubagent } from "#subagents/remote/start.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { classifyFreshStart, resolveAgentInvocationAction, startSubagent } from "#tasks/start.js";

const createSessionMock = vi.fn();

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(() => ({ createSession: createSessionMock })),
}));
vi.mock("#subagents/tool.js", () => ({ buildSubagentRunInput: vi.fn() }));
vi.mock("#subagents/remote/start.js", () => ({ startRemoteSubagent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  createSessionMock.mockResolvedValue({
    events: new ReadableStream(),
    sessionId: "candidate-session",
  });
  vi.mocked(buildSubagentRunInput).mockReturnValue({
    childContinuationToken: "child-token",
    runInput: {} as never,
  });
  vi.mocked(startRemoteSubagent).mockResolvedValue({ kind: "error" } as never);
});

const localAction = {
  callId: "call-1",
  description: "Research",
  input: { message: "Find it" },
  kind: "subagent-call" as const,
  name: "research",
  nodeId: "subagents/research",
  subagentName: "research",
};

function session(rootSessionId?: string) {
  return {
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
    continuationToken: "parent-token",
    history: [],
    rootSessionId,
    sessionId: "parent",
  };
}

function startInput(
  target: Parameters<typeof startSubagent>[0]["target"],
  overrides: Partial<Parameters<typeof startSubagent>[0]> = {},
): Parameters<typeof startSubagent>[0] {
  return {
    auth: null,
    batchEvent: { sequence: 1, turnId: "turn-1" },
    bundle: { compiledArtifactsSource: {} } as never,
    callbackBaseUrl: "https://parent.example",
    capabilities: undefined,
    channelMetadata: undefined,
    fanoutSize: 1,
    initiatorAuth: null,
    parentContinuationToken: "parent-token",
    sandboxSessionId: "parent-session",
    taskId: "researcher-aaaaaa",
    session: { rootSessionId: "root-session", sessionId: "parent-session" } as never,
    trace: { originAudience: "private" },
    target,
    ...overrides,
  };
}

describe("classifyFreshStart", () => {
  it("rejects recursive self-agent starts outside the root session", () => {
    expect(
      classifyFreshStart({
        action: { ...localAction, name: "agent", nodeId: "__root__", subagentName: "agent" },
        bundle: {
          subagentRegistry: { subagentsByNodeId: new Map() },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        session: session("root") as never,
      }),
    ).toMatchObject({
      kind: "reject",
      result: { output: { code: "RECURSIVE_AGENT_ROOT_ONLY" } },
    });
  });

  it("rejects a dynamic target omitted from the current selection", () => {
    expect(
      classifyFreshStart({
        action: localAction,
        bundle: {
          subagentRegistry: {
            dynamicNodeIds: new Set([localAction.nodeId]),
            subagentsByNodeId: new Map(),
          },
          turnAgent: {},
        } as never,
        ctx: { get: () => undefined } as never,
        session: session() as never,
      }),
    ).toMatchObject({ kind: "reject", result: { output: { code: "SUBAGENT_UNAVAILABLE" } } });
  });

  it("starts a declared local agent with its description", () => {
    expect(
      classifyFreshStart({
        action: localAction,
        bundle: {
          subagentRegistry: {
            subagentsByNodeId: new Map([
              [localAction.nodeId, { definition: { description: "Research", kind: "subagent" } }],
            ]),
          },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        session: session() as never,
      }),
    ).toMatchObject({
      kind: "start",
      target: { action: localAction, kind: "local", source: { description: "Research" } },
    });
  });
});

describe("resolveAgentInvocationAction", () => {
  function contextWith(definition: Record<string, unknown>): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      subagentRegistry: { subagentsByName: new Map([[definition.name, { definition }]]) },
    } as never);
    return ctx;
  }

  it("resolves a declared local agent and keeps the continuation fields", () => {
    const outputSchema = { type: "object" };
    expect(
      resolveAgentInvocationAction({
        ctx: contextWith({
          description: "Research",
          kind: "subagent",
          name: "research",
          nodeId: "subagents/research",
        }),
        input: { message: "Find it", outputSchema, target: "research", taskId: "research-abc234" },
        invocationId: "call-1",
      }),
    ).toEqual({
      callId: "call-1",
      description: "Research",
      input: { message: "Find it", outputSchema, taskId: "research-abc234" },
      kind: "subagent-call",
      name: "research",
      nodeId: "subagents/research",
      subagentName: "research",
    });
  });

  it("resolves a remote agent", () => {
    expect(
      resolveAgentInvocationAction({
        ctx: contextWith({ kind: "remote", name: "billing", nodeId: "subagents/billing.ts" }),
        input: { message: "Check the invoice", target: "billing" },
        invocationId: "call-1",
      }),
    ).toMatchObject({ kind: "remote-agent-call", remoteAgentName: "billing" });
  });

  it("fails for a target the agent cannot call", () => {
    expect(() =>
      resolveAgentInvocationAction({
        ctx: contextWith({ kind: "subagent", name: "research", nodeId: "subagents/research" }),
        input: { message: "Find it", target: "missing" },
        invocationId: "call-1",
      }),
    ).toThrow('Agent target "missing" is not available to this agent.');
  });
});

describe("startSubagent", () => {
  it.each(["local", "remote"] as const)(
    "passes one parent context to the %s child with the exact caller span",
    async (kind) => {
      const caller = {
        spanId: "2".repeat(16),
        traceFlags: 1,
        traceId: "1".repeat(32),
      };

      await startSubagent(
        startInput(
          kind === "local"
            ? {
                action: { callId: "child-action" } as never,
                kind,
                source: { type: "runtime" },
              }
            : { action: { callId: "child-action" } as never, kind },
          { trace: { originAudience: "private", parentTraceContext: caller } },
        ),
      );

      const parent = {
        conversationId: "root-session",
        continuationToken: "parent-token",
        lineage: {
          callId: "child-action",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "turn-1", sequence: 1 },
        },
        traceContext: caller,
        originAudience: "private",
      };
      if (kind === "local") {
        expect(buildSubagentRunInput).toHaveBeenCalledWith(
          expect.objectContaining({ parent, taskId: "researcher-aaaaaa" }),
        );
        expect(startRemoteSubagent).not.toHaveBeenCalled();
      } else {
        expect(startRemoteSubagent).toHaveBeenCalledWith(expect.objectContaining({ parent }));
        expect(buildSubagentRunInput).not.toHaveBeenCalled();
      }
    },
  );

  it("starts a local child without waiting for it to claim its address", async () => {
    const outcome = await startSubagent(
      startInput({
        action: localAction as never,
        kind: "local",
        source: { description: "Research", type: "local" },
      }),
    );

    expect(createWorkflowRuntime).toHaveBeenCalledOnce();
    expect(createSessionMock).toHaveBeenCalledOnce();
    // The owner-assigned task ID names the child's continuation address, its start lock.
    expect(buildSubagentRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "researcher-aaaaaa" }),
    );
    expect(outcome).toEqual({ kind: "started" });
  });

  it("reports a local start failure as an error result", async () => {
    createSessionMock.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await startSubagent(
      startInput({
        action: localAction as never,
        kind: "local",
        source: { description: "Research", type: "local" },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      result: { callId: "call-1", isError: true, output: { code: "START_FAILED" } },
    });
  });

  it("passes an inherited task activity observer through to a local child unchanged", async () => {
    const activityObserver = {
      sink: { url: "https://parent.example/activity", version: 1 as const },
      workIdentity: {
        id: "work:task",
        kind: "task" as const,
        name: "slack",
        parentId: "work:root",
        rootSessionId: "root-session",
        rootTurnId: "root-turn",
      },
    };

    await startSubagent(
      startInput(
        {
          action: { ...localAction, name: "slack", nodeId: "subagents/slack" } as never,
          kind: "local",
          source: { description: "Search Slack", type: "local" },
        },
        { activityObserver },
      ),
    );

    expect(buildSubagentRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ activityObserver }),
    );
    expect(createSessionMock).toHaveBeenCalledOnce();
  });
});
