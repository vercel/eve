import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { executeTaskControlAction } from "#execution/tasks/dispatch.js";
import { readLatestTaskSnapshot, sendTaskCommand } from "#execution/tasks/run-control.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";

vi.mock("#execution/tasks/run-control.js", () => ({
  readLatestTaskSnapshot: vi.fn(),
  sendTaskCommand: vi.fn(),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-runtime.js")>()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#execution/remote-agent-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/remote-agent-dispatch.js")>()),
  cancelRemoteAgentTurn: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
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
          continuationToken: "child-token",
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
            commandToken: "task-token",
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
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue({
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
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({ status: "accepted" });
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

  it("uses task-scoped cancellation before child-turn identity arrives", async () => {
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue({
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
});
