import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import {
  sendTaskCommand,
  startTaskRun,
  waitForTaskCommandOwner,
} from "#execution/tasks/parent/run-parent.js";
import {
  backgroundToolExecutionProvider,
  readRetainedBackgroundToolResult,
} from "#execution/tasks/parent/tool-execution.js";
import { steerBackgroundAgent } from "#execution/tools/subagent/steer.js";
import {
  BackgroundToolExecutorKey,
  createBackgroundToolCallBatch,
} from "#harness/background-tools.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessSession } from "#harness/types.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";
import { getSessionTaskIndex, recordSessionTask } from "#tasks/session-index.js";
vi.mock("#execution/tools/subagent/steer.js", () => ({ steerBackgroundAgent: vi.fn() }));
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
    vi.mocked(steerBackgroundAgent).mockResolvedValue(undefined);
    vi.mocked(startTaskRun).mockResolvedValue(undefined as never);
    vi.mocked(waitForTaskCommandOwner).mockResolvedValue({ runId: "steering-task-run" } as never);
  });

  it("steers the existing child without replacing its task, claim, or receipt", async () => {
    const scope = await createScope();
    const receipt = await scope.execute();
    expect(steerBackgroundAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle,
        callId: "steering-call",
        input: { agentId: identity.id, message: "Use the updated instruction" },
      }),
    );
    expect(receipt).toEqual({ agentId: identity.id, status: "working", taskId: entry.taskId });
    const session = await scope.commit();
    expect(getAgentHandleStore(session.state)?.handles).toEqual([handle]);
    expect(getSessionTaskIndex(session.state)).toEqual([entry]);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(waitForTaskCommandOwner).not.toHaveBeenCalled();
    expect(sendTaskCommand).not.toHaveBeenCalled();
  });

  it("keeps the original claim and starts no replacement when delivery fails", async () => {
    const scope = await createScope();
    vi.mocked(steerBackgroundAgent).mockRejectedValueOnce(new Error("Delivery failed"));
    await expect(scope.execute()).rejects.toThrow("Delivery failed");
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([handle]);
  });

  it("does not steer a task outside the parent task index", async () => {
    const scope = await createScope(createSession(false));
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
  });

  it("does not steer a task associated with another child", async () => {
    const scope = await createScope(
      recordSessionTask(createSession(), {
        ...entry,
        metadata: { ...entry.metadata, agentId: "another-child" },
      }),
    );
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
  });

  it("rejects a different subagent tool before delivery", async () => {
    const scope = await createScope();
    await expect(scope.execute("call-1", identity.id, "another-tool")).rejects.toThrow(
      "AGENT_MISMATCH",
    );
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
  });

  it("rejects a different local/remote target before delivery", async () => {
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
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
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
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
  });

  it("preserves a different child's claim made while steering was pending", async () => {
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
    const delivery = Promise.withResolvers<void>();
    vi.mocked(steerBackgroundAgent).mockReturnValueOnce(delivery.promise);
    const first = scope.execute();
    await scope.execute("second-call", second.identity.id);
    delivery.resolve();
    await first;
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([
      handle,
      expect.objectContaining({
        identity: second.identity,
        phase: "claimed",
        callId: "second-call",
      }),
    ]);
  });

  it("accepts concurrent steering without transferring ownership", async () => {
    const scope = await createScope();
    const receipts = await Promise.all([scope.execute("first-call"), scope.execute("second-call")]);
    expect(receipts).toEqual([
      { agentId: identity.id, status: "working", taskId: entry.taskId },
      { agentId: identity.id, status: "working", taskId: entry.taskId },
    ]);
    expect(steerBackgroundAgent).toHaveBeenCalledTimes(2);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([handle]);
  });

  it("allows another steering attempt after delivery fails", async () => {
    const scope = await createScope();
    vi.mocked(steerBackgroundAgent).mockRejectedValueOnce(new Error("Delivery failed"));
    await expect(scope.execute("first-call")).rejects.toThrow("Delivery failed");

    await expect(scope.execute("retry-call")).resolves.toMatchObject({
      agentId: identity.id,
      status: "working",
    });
    expect(steerBackgroundAgent).toHaveBeenCalledTimes(2);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([handle]);
  });

  it.each([new Error("Parent step failed"), new TurnCancelledError()])(
    "does not compensate the pre-existing task on rollback: %s",
    async (cause) => {
      const scope = await createScope();
      await scope.execute();
      await scope.rollback(cause);
      expect(sendTaskCommand).not.toHaveBeenCalled();
      expect(getAgentHandleStore((await scope.commit()).state)?.handles).toEqual([handle]);
      expect(scope.retained()).toBeUndefined();
    },
  );
});
