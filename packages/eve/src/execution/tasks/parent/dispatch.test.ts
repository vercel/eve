import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { deserializeContext } from "#context/serialize.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
  resolveRemoteAgentStreamHeaders,
} from "#execution/remote-agent-dispatch.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import { readLatestTaskView, sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  readLatestTaskView: vi.fn(),
  sendTaskCommand: vi.fn(),
}));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({
  getDynamicSubagentSelection: vi.fn(),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-runtime.js")>()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#execution/remote-agent-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/remote-agent-dispatch.js")>()),
  cancelRemoteAgentTurn: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
  resolveRemoteAgentStreamHeaders: vi.fn(),
}));

const action: RuntimeToolCallActionRequest = {
  callId: "call-cancel",
  input: { taskIds: ["task-1"] },
  kind: "tool-call",
  toolName: "task_cancel",
};

function createSession(mode: "local" | "remote"): RuntimeSession {
  const address =
    mode === "local"
      ? { continuationToken: "child-token", kind: "agent/local" as const, sessionId: "child-1" }
      : {
          callbackBaseUrl: "https://parent.example",
          kind: "agent/remote" as const,
          sessionId: "child-1",
          url: "https://child.example",
        };
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state: {
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [
          {
            address,
            identity: { id: "agent-1", name: "research", nodeId: "node-1" },
            phase: "addressed",
          },
        ],
      },
      [SESSION_TASKS_STATE_KEY]: {
        tasks: [
          {
            taskInboxToken: "task-token",
            createdByTurnId: "turn-1",
            metadata: {
              agentId: "agent-1",
              kind: "subagent",
              mode,
              name: "research",
            },
            operationId: "operation-1",
            taskId: "task-1",
            taskRunId: "run-1",
          },
        ],
      },
    },
  } as RuntimeSession;
}

describe("task cancellation identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommand).mockResolvedValue("delivered");
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "local",
        name: "research",
      },
      executor: { childSessionId: "child-1", childTurnId: "turn_child_7" },
      status: "cancelled",
      taskId: "task-1",
    });
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue({ name: "research" } as never);
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({
      sessionId: "child-1",
      status: "accepted",
    });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({
      sessionId: "child-1",
      status: "accepted",
    });
    vi.mocked(resolveRemoteAgentStreamHeaders).mockResolvedValue({ authorization: "Bearer fresh" });
    vi.mocked(deserializeContext).mockResolvedValue("context" as never);
    vi.mocked(getDynamicSubagentSelection).mockReturnValue(undefined);
  });

  it.each(["local", "remote"] as const)(
    "guards %s cancellation with the task's child turn",
    async (mode) => {
      const result = await executeTaskControlAction({
        action,
        bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
        parentTurnId: "turn-parent",
        session: createSession(mode),
      });

      if (mode === "local") {
        expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
          sessionId: "child-1",
          taskId: "task-1",
          turnId: "turn_child_7",
        });
        expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
      } else {
        expect(cancelRemoteAgentTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "child-1",
            taskId: "task-1",
            turnId: "turn_child_7",
          }),
        );
        expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
      }
      expect(result.result).toMatchObject({ output: { tasks: [{ status: "cancelled" }] } });
      expect(result.session.state?.[AGENT_HANDLES_STATE_KEY]).toMatchObject({
        handles: [{ phase: "addressed" }],
      });
    },
  );

  it("cancels a dynamic remote task with its creation-time credential resolver", async () => {
    const session = createSession("remote");
    const handleStore = session.state?.[AGENT_HANDLES_STATE_KEY] as {
      handles: Array<{ address: { credentialResolver?: { resolverId?: string } } }>;
    };
    handleStore.handles[0]!.address.credentialResolver = {
      resolverId: "dynamic-credentials-step",
    };
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "remote",
        name: "research",
      },
      executor: {
        binding: {
          data: {
            address: handleStore.handles[0]!.address,
            identity: { id: "agent-1", name: "research", nodeId: "node-1" },
          },
          kind: "subagent",
        },
        childSessionId: "child-1",
        childTurnId: "turn_child_7",
      },
      status: "cancelled",
      taskId: "task-1",
    });

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      session,
    });

    expect(resolveRemoteAgentForAction).not.toHaveBeenCalled();
    expect(resolveRemoteAgentStreamHeaders).toHaveBeenCalledWith({
      bundle: expect.any(Object),
      name: "research",
      resolverId: "dynamic-credentials-step",
      url: "https://child.example",
    });
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { authorization: "Bearer fresh" },
        remote: { name: "research", url: "https://child.example" },
        sessionId: "child-1",
        turnId: "turn_child_7",
      }),
    );
  });

  it("does not resolve authored credentials when creation recorded none", async () => {
    const session = createSession("remote");
    const address = (
      session.state?.[AGENT_HANDLES_STATE_KEY] as {
        handles: Array<{ address: { credentialResolver?: { resolverId?: string } } }>;
      }
    ).handles[0]!.address;
    address.credentialResolver = {};
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { agentId: "agent-1", kind: "subagent", mode: "remote", name: "research" },
      executor: {
        binding: {
          data: {
            address,
            identity: { id: "agent-1", name: "research", nodeId: "node-1" },
          },
          kind: "subagent",
        },
        childSessionId: "child-1",
        childTurnId: "turn_child_7",
      },
      status: "cancelled",
      taskId: "task-1",
    });

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      session,
    });

    expect(resolveRemoteAgentForAction).not.toHaveBeenCalled();
    expect(resolveRemoteAgentStreamHeaders).not.toHaveBeenCalled();
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {},
        remote: { name: "research", url: "https://child.example" },
      }),
    );
  });

  it("recovers the current dynamic selection for a legacy remote binding", async () => {
    const dynamicRemoteAgent = {
      credentialsStepId: "legacy-dynamic-step",
      description: "Remote research",
      path: "/eve/v1/session",
      url: "https://child.example",
    };
    vi.mocked(getDynamicSubagentSelection).mockReturnValue({
      kind: "remote",
      prepared: {} as never,
      remoteAgent: dynamicRemoteAgent,
    });

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      serializedContext: { context: "serialized" },
      session: createSession("remote"),
    });

    expect(deserializeContext).toHaveBeenCalledWith({ context: "serialized" });
    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicRemoteAgent }),
    );
  });

  it("does not send current credentials to a legacy child's previous URL", async () => {
    vi.mocked(getDynamicSubagentSelection).mockReturnValue({
      kind: "remote",
      prepared: {} as never,
      remoteAgent: {
        credentialsStepId: "new-dynamic-step",
        description: "Remote research",
        path: "/eve/v1/session",
        url: "https://new-child.example",
      },
    });
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue({
      name: "research",
      url: "https://new-child.example",
    } as never);

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      serializedContext: { context: "serialized" },
      session: createSession("remote"),
    });

    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {},
        remote: { name: "research", url: "https://child.example" },
      }),
    );
    expect(resolveRemoteAgentStreamHeaders).not.toHaveBeenCalled();
  });

  it("uses fresh current credentials when a legacy child's URL still matches", async () => {
    const auth = vi.fn();
    const headers = vi.fn();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue({
      auth,
      headers,
      name: "research",
      url: "https://child.example",
    } as never);

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      session: createSession("remote"),
    });

    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: expect.objectContaining({
          auth,
          headers,
          name: "research",
          url: "https://child.example",
        }),
      }),
    );
    expect(vi.mocked(cancelRemoteAgentTurn).mock.calls[0]?.[0]).not.toHaveProperty("headers");
  });

  it("preserves resolved headers when retrying an unguarded remote cancel", async () => {
    vi.mocked(cancelRemoteAgentTurn)
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ sessionId: "child-1", status: "accepted" });
    const session = createSession("remote");
    const address = (
      session.state?.[AGENT_HANDLES_STATE_KEY] as {
        handles: Array<{ address: { credentialResolver?: { resolverId?: string } } }>;
      }
    ).handles[0]!.address;
    address.credentialResolver = { resolverId: "dynamic-credentials-step" };
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { agentId: "agent-1", kind: "subagent", mode: "remote", name: "research" },
      executor: {
        binding: {
          data: {
            address,
            identity: { id: "agent-1", name: "research", nodeId: "node-1" },
          },
          kind: "subagent",
        },
        childSessionId: "child-1",
        childTurnId: "turn_child_7",
      },
      status: "cancelled",
      taskId: "task-1",
    });

    await executeTaskControlAction({
      action,
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      parentTurnId: "turn-parent",
      session,
    });

    expect(cancelRemoteAgentTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headers: { authorization: "Bearer fresh" } }),
    );
    expect(vi.mocked(cancelRemoteAgentTurn).mock.calls[1]?.[0]).not.toHaveProperty("turnId");
  });

  it("uses task-scoped cancellation before child-turn identity arrives", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { agentId: "agent-1", kind: "subagent", mode: "local", name: "research" },
      status: "cancelled",
      taskId: "task-1",
    });

    await executeTaskControlAction({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-parent",
      session: createSession("local"),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
      sessionId: "child-1",
      taskId: "task-1",
    });
    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
  });

  it("does not propagate a repeated cancel after the task hook is disposed", async () => {
    vi.mocked(sendTaskCommand).mockResolvedValue("unreachable");

    await executeTaskControlAction({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-parent",
      session: createSession("local"),
    });

    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
  });

  it("fails instead of reporting success when cancellation does not commit", async () => {
    vi.useFakeTimers();
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { agentId: "agent-1", kind: "subagent", mode: "local", name: "research" },
      status: "working",
      taskId: "task-1",
    });
    try {
      const pending = executeTaskControlAction({
        action,
        bundle: {} as CompiledBundle,
        parentTurnId: "turn-parent",
        session: createSession("local"),
      });
      const rejected = expect(pending).rejects.toThrow("did not commit cancellation");
      await vi.runAllTimersAsync();
      await rejected;
      expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
