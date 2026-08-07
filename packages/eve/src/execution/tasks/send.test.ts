import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchToTaskAgentAddress,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
} from "#execution/tasks/delegate.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { executeTaskSend } from "#execution/tasks/send.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";
import type { TaskStatus, TaskView } from "#tasks/types.js";

vi.mock("#execution/agent-handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/agent-handle-dispatch.js")>()),
  dispatchToTaskAgentAddress: vi.fn(),
}));

vi.mock("#execution/tasks/delegate.js", () => ({
  beginDelegatedTask: vi.fn(),
  failDelegatedDispatch: vi.fn(),
  settleDelegatedDispatch: vi.fn(),
}));

vi.mock("#execution/tasks/run-control.js", () => ({
  readLatestTaskSnapshot: vi.fn(),
  sendTaskCommand: vi.fn(),
}));

const agentId = "ag_research:abcdef123456";
const metadata = { agentId, kind: "subagent" as const, mode: "local" as const, name: "research" };

function task(taskId: string, status: TaskStatus): TaskView {
  return { metadata, status, taskId };
}

function createSession(includeActive = false, activeCreatedByTurnId = "turn-1"): RuntimeSession {
  const tasks = [
    {
      commandToken: "task-token-terminal",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-terminal",
      taskId: "task_terminal",
      taskRunId: "run-terminal",
    },
    ...(includeActive
      ? [
          {
            commandToken: "task-token-active",
            createdByTurnId: activeCreatedByTurnId,
            metadata,
            operationId: "operation-active",
            taskId: "task_active",
            taskRunId: "run-active",
          },
        ]
      : []),
  ];
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
            address: {
              continuationToken: "child-token",
              kind: "agent/local",
              sessionId: "child-session",
            },
            identity: { id: agentId, name: "research", nodeId: "node-research" },
            phase: "addressed",
          },
        ],
      },
      [SESSION_TASKS_STATE_KEY]: { tasks },
    },
  } as RuntimeSession;
}

const action: RuntimeToolCallActionRequest = {
  callId: "call-send",
  input: { message: "continue", taskId: "task_terminal" },
  kind: "tool-call",
  toolName: "task_send",
};

describe("task_send persistent-agent admission", () => {
  beforeEach(() => vi.resetAllMocks());

  it("starts a new task on the same address after terminal work", async () => {
    const session = createSession();
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(task("task_terminal", "completed"));
    vi.mocked(beginDelegatedTask).mockResolvedValue({
      commandToken: "task-token-new",
      createdByTurnId: "turn-2",
      metadata,
      operationId: "operation-new",
      taskId: "task_new",
      taskRunId: "run-new",
    });
    vi.mocked(dispatchToTaskAgentAddress).mockResolvedValue({
      address: {
        continuationToken: "child-token",
        kind: "agent/local",
        sessionId: "child-session",
      },
      callId: action.callId,
      kind: "called",
      name: "research",
      session,
      toolName: "research",
    });
    vi.mocked(settleDelegatedDispatch).mockResolvedValue({
      receipt: {} as never,
      session,
    });

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-2",
      session,
    });

    expect(beginDelegatedTask).toHaveBeenCalledWith(expect.objectContaining({ agentId }));
    expect(dispatchToTaskAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, currentSession: session }),
    );
    expect(result.result).toMatchObject({
      output: { agentId, status: "working", taskId: "task_new" },
    });
  });

  it("rejects a follow-up while another nonterminal task owns the agent", async () => {
    const session = createSession(true);
    vi.mocked(readLatestTaskSnapshot).mockImplementation(async ({ taskRunId }) =>
      taskRunId === "run-active"
        ? task("task_active", "input_required")
        : task("task_terminal", "completed"),
    );

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-2",
      session,
    });

    expect(result.result).toMatchObject({
      isError: true,
      output: { message: expect.stringContaining("task_active") },
    });
    expect(beginDelegatedTask).not.toHaveBeenCalled();
    expect(dispatchToTaskAgentAddress).not.toHaveBeenCalled();
    expect(failDelegatedDispatch).not.toHaveBeenCalled();
  });

  it("rejects a second same-batch follow-up even if the first task already completed", async () => {
    const session = createSession(true, "turn-2");
    vi.mocked(readLatestTaskSnapshot).mockImplementation(async ({ taskRunId }) =>
      taskRunId === "run-active"
        ? task("task_active", "completed")
        : task("task_terminal", "completed"),
    );

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-2",
      session,
    });

    expect(result.result).toMatchObject({
      isError: true,
      output: { message: expect.stringContaining("AGENT_BUSY") },
    });
    expect(beginDelegatedTask).not.toHaveBeenCalled();
    expect(dispatchToTaskAgentAddress).not.toHaveBeenCalled();
  });

  it("reserves the addressed agent before an ambiguous delivery", async () => {
    const current = createSession();
    const reserved = createSession(true, "turn-2");
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(task("task_terminal", "completed"));
    vi.mocked(beginDelegatedTask).mockResolvedValue({
      commandToken: "task-token-new",
      createdByTurnId: "turn-2",
      metadata,
      operationId: "operation-new",
      taskId: "task_active",
      taskRunId: "run-active",
    });
    vi.mocked(settleDelegatedDispatch).mockResolvedValue({
      receipt: {} as never,
      session: reserved,
    });
    vi.mocked(dispatchToTaskAgentAddress).mockResolvedValue({
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: { code: "AGENT_UNREACHABLE", message: "response lost" },
        subagentName: "research",
      },
      session: reserved,
    });

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-2",
      session: current,
    });

    expect(vi.mocked(settleDelegatedDispatch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchToTaskAgentAddress).mock.invocationCallOrder[0] ?? 0,
    );
    expect(dispatchToTaskAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({ currentSession: reserved }),
    );
    expect(result.result).toMatchObject({ isError: true, output: { taskId: "task_active" } });
    expect(result.session).toBe(reserved);
  });
});
