import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { startTaskRun, waitForTaskCommandOwner } from "#execution/tasks/parent/run-parent.js";
import {
  backgroundToolExecutionProvider,
  readRetainedBackgroundToolResult,
} from "#execution/tasks/parent/tool-execution.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import {
  BackgroundToolExecutorKey,
  createBackgroundToolCallBatch,
} from "#harness/background-tools.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessSession } from "#harness/types.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";
import { applyTaskAgentHandleCommand } from "#subagents/handles/transitions.js";
import { getSessionTaskIndex, recordSessionTask } from "#tasks/session-index.js";

vi.mock("#execution/tasks/parent/dispatch.js", () => ({ cancelOwnedTask: vi.fn() }));
vi.mock("#execution/tools/subagent/task-cancel.js", () => ({ cancelBackgroundAgentTask: vi.fn() }));
vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  sendTaskCommand: vi.fn(async () => "delivered"),
  startTaskRun: vi.fn(),
  waitForTaskCommandOwner: vi.fn(),
}));

const identity = { id: "agent-1", name: "research", nodeId: "subagents/research" };
const address = {
  continuationToken: "child-token",
  kind: "agent/local" as const,
  sessionId: "child-session",
};
const handle = {
  address,
  callId: "original-call",
  identity,
  operationId: "original-operation",
  ownerId: "original-task",
  phase: "claimed" as const,
};
const entry = {
  createdByTurnId: "turn-1",
  metadata: { agentId: identity.id, kind: "subagent", name: identity.name },
  taskId: handle.ownerId,
  taskInboxToken: "original-task-inbox",
  taskRunId: "original-task-run",
};
const cancelledView = {
  metadata: entry.metadata,
  status: "cancelled" as const,
  taskId: entry.taskId,
};

function createSession(owned = true): HarnessSession {
  const session = setHarnessEmissionState(
    {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent",
      state: setAgentHandleStore(undefined, { handles: [handle] }),
    },
    { sessionStarted: true, sequence: 2, stepIndex: 0, turnId: "turn-2" },
  );
  return owned ? recordSessionTask(session, entry) : session;
}

async function createScope(session = createSession()) {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: session.sessionId,
    turn: { id: "turn-2", sequence: 2 },
  });
  const created = await backgroundToolExecutionProvider.create(ctx, session);
  if (created === undefined) throw new Error("Expected background executor");
  const executor = created.value;
  ctx.setVirtualContext(BackgroundToolExecutorKey, executor);
  const batch = createBackgroundToolCallBatch();
  return {
    execute(
      callId = "steering-call",
      agentId: string | undefined = identity.id,
      name = identity.name,
    ) {
      const definition = {
        execute: vi.fn(),
        name,
        nodeId: identity.nodeId,
        resultKind: "subagent" as const,
        workflowId: "research-workflow",
      };
      const toolInput = { agentId, message: "Use the updated instruction" };
      batch.setTool(name, definition);
      batch.register({ callId, input: toolInput, toolName: name });
      return contextStorage.run(ctx, () =>
        executor.execute({
          batch,
          definition,
          options: { messages: [], toolCallId: callId },
          toolInput,
        }),
      );
    },
    commit: () => backgroundToolExecutionProvider.commit!(executor, session),
    rollback: (cause: unknown) => backgroundToolExecutionProvider.rollback!(executor, cause),
    retained: () => readRetainedBackgroundToolResult(ctx),
  };
}

describe("background subagent steering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cancelOwnedTask).mockResolvedValue(cancelledView);
    vi.mocked(startTaskRun).mockResolvedValue(undefined as never);
    vi.mocked(waitForTaskCommandOwner).mockResolvedValue({ runId: "steering-task-run" } as never);
  });

  it("cancels the old task before starting a new task in the same child", async () => {
    const scope = await createScope();
    const cancellation = Promise.withResolvers<typeof cancelledView>();
    vi.mocked(cancelOwnedTask).mockReturnValue(cancellation.promise);
    const steering = scope.execute();
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(cancelOwnedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelOwnedWork: cancelBackgroundAgentTask,
        entry,
        serializedContext: {},
      }),
    );

    cancellation.resolve(cancelledView);
    const receipt = await steering;
    expect(receipt).toMatchObject({ agentId: identity.id, status: "working" });
    const session = await scope.commit();
    const claimed = getAgentHandleStore(session.state)?.handles[0];
    expect(claimed).toMatchObject({ address, identity, phase: "claimed", callId: "steering-call" });
    expect(claimed).not.toHaveProperty("ownerId", entry.taskId);
    expect(getSessionTaskIndex(session.state)).toHaveLength(2);

    const released = applyTaskAgentHandleCommand(session, {
      kind: "release-owner",
      ownerId: entry.taskId,
    });
    expect(released.session).toBe(session);
  });

  it("keeps the original claim and starts no replacement when cancellation fails", async () => {
    const scope = await createScope();
    vi.mocked(cancelOwnedTask).mockRejectedValue(new Error("Cancellation did not commit"));
    await expect(scope.execute()).rejects.toThrow("Cancellation did not commit");
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([handle]);
  });

  it("does not cancel a task outside the parent task index", async () => {
    const scope = await createScope(createSession(false));
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("does not cancel a task associated with another child", async () => {
    const scope = await createScope(
      recordSessionTask(createSession(), {
        ...entry,
        metadata: { ...entry.metadata, agentId: "another-child" },
      }),
    );
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("rejects a different subagent tool before cancellation", async () => {
    const scope = await createScope();
    await expect(scope.execute("call-1", identity.id, "another-tool")).rejects.toThrow(
      "AGENT_MISMATCH",
    );
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("rejects a different local/remote target before cancellation", async () => {
    const session = createSession();
    const scope = await createScope({
      ...session,
      state: setAgentHandleStore(session.state, {
        handles: [
          {
            ...handle,
            address: {
              kind: "agent/remote",
              sessionId: address.sessionId,
              url: "https://child.example",
              callbackBaseUrl: "https://parent.example",
            },
          },
        ],
      }),
    });
    await expect(scope.execute()).rejects.toThrow("AGENT_MISMATCH");
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("does not steer a reservation before the child has an address", async () => {
    const { address: _address, ...reservation } = handle;
    const session = createSession();
    const scope = await createScope({
      ...session,
      state: setAgentHandleStore(session.state, {
        handles: [{ ...reservation, phase: "reserved" }],
      }),
    });
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("preserves a different child's claim made while cancellation was pending", async () => {
    const second = {
      address: { ...address, sessionId: "second-session" },
      identity: { ...identity, id: "agent-2" },
      phase: "available" as const,
    };
    const session = createSession();
    const scope = await createScope({
      ...session,
      state: setAgentHandleStore(session.state, { handles: [handle, second] }),
    });
    const cancellation = Promise.withResolvers<typeof cancelledView>();
    vi.mocked(cancelOwnedTask).mockReturnValue(cancellation.promise);
    const first = scope.execute();
    await scope.execute("second-call", second.identity.id);
    cancellation.resolve(cancelledView);
    await first;
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([
      expect.objectContaining({ identity, phase: "claimed", callId: "steering-call" }),
      expect.objectContaining({
        identity: second.identity,
        phase: "claimed",
        callId: "second-call",
      }),
    ]);
  });

  it("admits only one of two simultaneous steering calls to the same child", async () => {
    const scope = await createScope();
    const cancellation = Promise.withResolvers<typeof cancelledView>();
    vi.mocked(cancelOwnedTask).mockReturnValue(cancellation.promise);
    const first = scope.execute("first-call");
    const second = scope.execute("second-call");
    cancellation.resolve(cancelledView);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(startTaskRun).toHaveBeenCalledTimes(1);
    expect(getAgentHandleStore((await scope.commit()).state)?.handles[0]).toMatchObject({
      callId: "first-call",
    });
  });

  it("retains the released child if the parent turn is cancelled before the replacement starts", async () => {
    const scope = await createScope();
    const cancellation = new TurnCancelledError();
    vi.mocked(startTaskRun).mockRejectedValueOnce(cancellation);
    await expect(scope.execute()).rejects.toThrow(cancellation);
    await scope.rollback(cancellation);
    const retained = scope.retained();
    expect(retained?.backgroundTasks).toEqual([]);
    expect(getAgentHandleStore(retained?.backgroundTaskSession.state)?.handles).toEqual([
      { address, identity, phase: "available" },
    ]);
  });
});
