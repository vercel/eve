import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityObserverConfig } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ActivityObserverKey, SessionKey, type SessionAuth } from "#context/keys.js";
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
import { getTaskInvocations, registerWorkflowInvocation } from "#harness/workflow-invocations.js";
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
  callId: handle.ownerId,
  toolName: { agentId: identity.id, kind: "subagent", name: identity.name }.name,
  resultKind: "tool" as const,
  lifetime: "session" as const,
  origin: { turnId: "turn-1", stepIndex: 0 },
  address: { runId: "original-task-run", hookToken: "original-task-inbox" },
  task: {
    dispatchContext: { auth: { current: null, initiator: null } },
    metadata: { agentId: identity.id, kind: "subagent", name: identity.name },
    taskId: handle.ownerId,
  },
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
  return owned ? registerWorkflowInvocation(session, entry) : session;
}

async function createScope(
  session = createSession(),
  activityObserver?: ActivityObserverConfig,
  auth: SessionAuth = { current: null, initiator: null },
) {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth,
    sessionId: session.sessionId,
    turn: { id: "turn-2", sequence: 2 },
  });
  if (activityObserver !== undefined) {
    ctx.setVirtualContext(ActivityObserverKey, activityObserver);
  }
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
      resultKind: "subagent" | "tool" = "subagent",
      label?: (input: unknown) => string,
    ) {
      const definition = {
        execute: vi.fn(),
        label: label === undefined ? undefined : { start: label },
        name,
        nodeId: identity.nodeId,
        resultKind,
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
    expect(receipt).toEqual({ agentId: identity.id, status: "working", taskId: entry.task.taskId });
    const session = await scope.commit();
    expect(getAgentHandleStore(session.state)?.handles).toEqual([handle]);
    expect(getTaskInvocations(session.state)).toEqual([entry]);
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

  it("persists the creating turn's auth on the background task", async () => {
    const creatorCurrent = {
      attributes: {},
      authenticator: "test-idp",
      issuer: "test-idp",
      principalId: "creator-current",
      principalType: "user" as const,
    };
    const creatorInitiator = { ...creatorCurrent, principalId: "creator-initiator" };
    const scope = await createScope(createSession(), undefined, {
      current: creatorCurrent,
      initiator: creatorInitiator,
    });

    await scope.execute("new-call", "");
    const committed = await scope.commit();
    const task = getTaskInvocations(committed.state).find(
      (candidate) => candidate.task.taskId !== entry.task.taskId,
    );

    expect(task?.task.dispatchContext).toEqual({
      auth: { current: creatorCurrent, initiator: creatorInitiator },
    });
    if (task === undefined) throw new Error("Expected created task");
    const replayed = registerWorkflowInvocation(committed, {
      ...task,
      task: {
        ...task.task,
        dispatchContext: {
          auth: {
            current: { ...creatorCurrent, principalId: "later-current" },
            initiator: { ...creatorInitiator, principalId: "later-initiator" },
          },
        },
      },
    });
    expect(
      getTaskInvocations(replayed.state).find(
        (candidate) => candidate.task.taskId === task.task.taskId,
      )?.task.dispatchContext,
    ).toEqual({ auth: { current: creatorCurrent, initiator: creatorInitiator } });
  });

  it("persists schedule-shaped auth with no current principal and one session initiator", async () => {
    const sessionInitiator = {
      attributes: {},
      authenticator: "test-idp",
      issuer: "test-idp",
      principalId: "session-initiator",
      principalType: "user" as const,
    };
    const scope = await createScope(createSession(), undefined, {
      current: null,
      initiator: sessionInitiator,
    });

    await scope.execute("new-call", "");
    const committed = await scope.commit();
    const task = getTaskInvocations(committed.state).find(
      (candidate) => candidate.task.taskId !== entry.task.taskId,
    );

    expect(task?.task.dispatchContext).toEqual({
      auth: { current: null, initiator: sessionInitiator },
    });
  });

  it.each(["subagent", "tool"] as const)(
    "retains activity identity for parent-owned settlement (%s)",
    async (resultKind) => {
      const activityObserver = {
        sink: { url: "https://parent.example/activity", version: 1 as const },
        workIdentity: {
          id: "work:root",
          kind: "root-turn" as const,
          rootSessionId: "parent",
          rootTurnId: "turn-2",
        },
      };
      const scope = await createScope(createSession(), activityObserver);

      await scope.execute("new-call", "", identity.name, resultKind);
      const committed = await scope.commit();
      const task = getTaskInvocations(committed.state).find(
        (candidate) => candidate.task.taskId !== entry.task.taskId,
      );

      expect(task).toBeDefined();
      expect(task?.task.activityWorkIdentity).toMatchObject({
        callId: "new-call",
        kind: "task",
        name: "research",
        parentId: "work:root",
        rootSessionId: "parent",
        rootTurnId: "turn-2",
      });
    },
  );

  it("persists a tool-derived task label without changing its subagent identity", async () => {
    const activityObserver = {
      sink: { url: "https://parent.example/activity", version: 1 as const },
      workIdentity: {
        id: "work:root",
        kind: "root-turn" as const,
        rootSessionId: "parent",
        rootTurnId: "turn-2",
      },
    };
    const scope = await createScope(createSession(), activityObserver);

    await scope.execute("new-call", "", identity.name, "subagent", (input) => {
      (input as { message: string }).message = "Mutated";
      return "Investigator";
    });
    expect(startTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: expect.objectContaining({
          input: { agentId: "", message: "Use the updated instruction" },
        }),
      }),
    );
    const committed = await scope.commit();
    const task = getTaskInvocations(committed.state).find(
      (candidate) => candidate.task.taskId !== entry.task.taskId,
    );

    expect(task).toMatchObject({
      task: {
        activityWorkIdentity: { label: "Investigator", name: "research" },
        metadata: { name: "research" },
      },
    });
  });

  it("does not steer a task outside the parent task index", async () => {
    const scope = await createScope(createSession(false));
    await expect(scope.execute()).rejects.toThrow("AGENT_BUSY");
    expect(steerBackgroundAgent).not.toHaveBeenCalled();
  });

  it("does not steer a task associated with another child", async () => {
    const scope = await createScope(
      registerWorkflowInvocation(createSession(), {
        ...entry,
        task: { ...entry.task, metadata: { ...entry.task.metadata, agentId: "another-child" } },
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
      { agentId: identity.id, status: "working", taskId: entry.task.taskId },
      { agentId: identity.id, status: "working", taskId: entry.task.taskId },
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
