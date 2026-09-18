import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchAgentInvocation,
  dispatchTaskAgentInvocationStep,
  releaseAgentInvocationOwnerStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { dispatchToClaimedAgentAddress } from "#subagents/handle-dispatch.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invoke-preparation.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
} from "#context/keys.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: vi.fn(() => ({ url: "https://parent.example" })),
}));
vi.mock("#subagents/handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchToClaimedAgentAddress: vi.fn(),
}));
vi.mock("#subagents/continuation-bundle.js", () => ({
  createAgentContinuationBundle: vi.fn(() => ({ nodeId: "child" })),
}));
vi.mock("#execution/tools/subagent/start.js", () => ({
  startSubagent: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-preparation.js", () => ({
  prepareOwnerAgentInvocation: vi.fn(),
}));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: vi.fn(),
}));
const action = {
  callId: "call-1",
  description: "Research",
  input: { message: "Find it" },
  kind: "subagent-call" as const,
  name: "research",
  nodeId: "subagents/research",
  subagentName: "research",
};
const creatorAuth = {
  attributes: {},
  authenticator: "test-idp",
  principalId: "creator-current",
  principalType: "user" as const,
};
const sessionInitiatorAuth = { ...creatorAuth, principalId: "session-initiator" };
const receiverAuth = { ...creatorAuth, principalId: "receiver-current" };
const receiverInitiatorAuth = { ...creatorAuth, principalId: "receiver-initiator" };
const availableRecord = {
  address: { continuationToken: "child", kind: "agent/local" as const, sessionId: "child" },
  identity: { id: "agent-1", name: "research", nodeId: "subagents/research" },
  phase: "available" as const,
};
const session = {
  agent: { system: "" },
  compaction: {},
  continuationToken: "parent-token",
  history: [],
  sessionId: "parent",
  state: setAgentHandleStore(undefined, { handles: [availableRecord] }),
};
const prepared = {
  adapter: {},
  adapterCtx: {},
  auth: null,
  batch: { event: { sequence: 1, stepIndex: 2, turnId: "turn-1" } },
  bundle: {},
  capabilities: undefined,
  channelMetadata: undefined,
  fanoutSize: 1,
  initiatorAuth: null,
  parentTraceContext: undefined,
  sandboxSessionId: "parent",
  serializedContext: {},
  session,
};
const called = {
  address: { continuationToken: "child", kind: "agent/local" as const, sessionId: "child" },
  callId: "call-1",
  kind: "called" as const,
  name: "research",
  session: session as never,
  toolName: "research",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readDurableSession).mockReturnValue(session as never);
});

describe("owner agent invocation dispatch", () => {
  it("resumes an addressed agent through its owning task", async () => {
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      plan: [{ action, agentId: "agent-1", kind: "resume" }],
    } as never);
    vi.mocked(dispatchToClaimedAgentAddress).mockResolvedValue(called);

    const dispatched = await dispatch();

    expect(dispatchToClaimedAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          identity: availableRecord.identity,
          phase: "claimed",
          ownerId: "task-1",
        }),
        reply: { kind: "reply", parentToken: "agent-reply", taskId: "task-1" },
      }),
    );
    expect(dispatched).toMatchObject({ agentId: "agent-1", kind: "dispatched" });
    expect(getAgentHandleStore(dispatched.sessionState.snapshot.session.state)?.handles).toEqual([
      expect.objectContaining({
        identity: availableRecord.identity,
        phase: "claimed",
        ownerId: "task-1",
      }),
    ]);
  });

  it("reuses a continuation claim admitted before the workflow body starts", async () => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "admission-operation",
      phase: "claimed" as const,
      ownerId: "task-1",
    };
    const claimedSession = {
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    };
    vi.mocked(readDurableSession).mockReturnValue(claimedSession as never);
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      session: claimedSession,
      plan: [{ action, agentId: "agent-1", kind: "resume" }],
    } as never);
    vi.mocked(dispatchToClaimedAgentAddress).mockResolvedValue(called);

    await dispatch();

    expect(dispatchToClaimedAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({ handle: claimed }),
    );
  });

  it("reuses one handle across blocking invocations with the same agentId", async () => {
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      plan: [{ action, agentId: "agent-1", kind: "resume" }],
    } as never);
    vi.mocked(dispatchToClaimedAgentAddress).mockResolvedValue(called);

    const first = await dispatchAgentInvocation({
      callbackBaseUrl: "https://parent.example",
      replyTo: "first-reply",
      request: {
        input: { agentId: "agent-1", message: "First", target: "research" },
        invocationId: "call-1:first",
        kind: "agent-invoke",
      },
      ownerId: "workflow-run-1",
      serializedContext: {},
      sessionState: {} as never,
    });
    expect(first.kind).toBe("dispatched");
    const firstHandle =
      first.kind === "dispatched"
        ? getAgentHandleStore(first.sessionState.snapshot.session.state)?.handles[0]
        : undefined;
    expect(firstHandle).toMatchObject({
      identity: { id: "agent-1" },
      ownerId: "workflow-run-1",
      phase: "claimed",
    });

    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [availableRecord] }),
    } as never);
    const second = await dispatchAgentInvocation({
      callbackBaseUrl: "https://parent.example",
      replyTo: "second-reply",
      request: {
        input: { agentId: "agent-1", message: "Second", target: "research" },
        invocationId: "call-1:second",
        kind: "agent-invoke",
      },
      ownerId: "workflow-run-1",
      serializedContext: {},
      sessionState: {} as never,
    });

    expect(second).toMatchObject({ agentId: "agent-1", kind: "dispatched" });
    expect(dispatchToClaimedAgentAddress).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(dispatchToClaimedAgentAddress)
        .mock.calls.map(([input]) => input.handle.identity.id),
    ).toEqual(["agent-1", "agent-1"]);
  });

  it.each([
    { dispatchKind: "start", taskKind: "subagent", observed: true },
    { dispatchKind: "resume", taskKind: "subagent", observed: true },
    { dispatchKind: "start", taskKind: "tool", observed: true },
    { dispatchKind: "resume", taskKind: "tool", observed: true },
    { dispatchKind: "start", taskKind: "subagent", observed: false },
    { dispatchKind: "resume", taskKind: "subagent", observed: false },
  ] as const)(
    "resolves task activity for $dispatchKind ($taskKind, observed=$observed)",
    async ({ dispatchKind, taskKind, observed }) => {
      const serializedContext = {
        [AuthKey.name]: receiverAuth,
        [InitiatorAuthKey.name]: receiverInitiatorAuth,
        [SessionDynamicSubagentSelectionsKey.name]: { source: "receiver-session" },
        [TurnDynamicSubagentSelectionsKey.name]: { source: "receiver-turn" },
        "eve.test": "preserved",
      };
      const taskDispatchContext = {
        auth: { current: creatorAuth, initiator: sessionInitiatorAuth },
        sessionDynamicSubagentSelections: { source: "creator-session" } as never,
        turnDynamicSubagentSelections: { source: "creator-turn" } as never,
      };
      const planningContext = {
        ...serializedContext,
        [AuthKey.name]: creatorAuth,
        [InitiatorAuthKey.name]: sessionInitiatorAuth,
        [SessionDynamicSubagentSelectionsKey.name]: { source: "creator-session" },
        [TurnDynamicSubagentSelectionsKey.name]: { source: "creator-turn" },
      };
      const taskWork = {
        callId: "task-call",
        id: "work:task",
        kind: "task" as const,
        name: "research",
        parentId: "work:root",
        rootSessionId: "root-session",
        rootTurnId: "root-turn",
      };
      const indexedSession = registerWorkflowToolRun(session, {
        callId: "task-1",
        toolName: { kind: taskKind, name: "research" }.name,
        lifetime: "session" as const,
        origin: { turnId: "turn-1", stepIndex: 0 },
        address: { runId: "task-run", hookToken: "task-token" },
        task: {
          activityWorkIdentity: taskWork,
          dispatchContext: taskDispatchContext,
          metadata: { kind: taskKind, name: "research" },
          taskId: "task-1",
        },
      });
      vi.mocked(readDurableSession).mockReturnValue(indexedSession as never);
      vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
        ...prepared,
        auth: creatorAuth,
        activityObserver: observed
          ? {
              sink: { url: "https://parent.example/activity", version: 1 },
              workIdentity: {
                id: "work:root",
                kind: "root-turn",
                rootSessionId: "root-session",
                rootTurnId: "root-turn",
              },
            }
          : undefined,
        initiatorAuth: sessionInitiatorAuth,
        plan: [
          dispatchKind === "start"
            ? { kind: "start", target: { action, kind: "local", source: { type: "runtime" } } }
            : { kind: "resume", action, agentId: "agent-1" },
        ],
        serializedContext: planningContext,
        session: indexedSession,
      } as never);
      vi.mocked(startSubagent).mockResolvedValue(called);
      vi.mocked(dispatchToClaimedAgentAddress).mockResolvedValue(called);

      const result = await dispatchTaskAgentInvocationStep({
        ownerId: "task-1",
        replyTo: "agent-reply",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "call-1",
          kind: "agent-invoke",
        },
        serializedContext,
        sessionState: {} as never,
        taskId: "task-1",
      });

      const taskObserver =
        observed && taskKind === "subagent"
          ? { sink: { url: "https://parent.example/activity", version: 1 }, workIdentity: taskWork }
          : undefined;
      if (dispatchKind === "start") {
        expect(startSubagent).toHaveBeenCalledWith(
          expect.objectContaining({
            auth: creatorAuth,
            initiatorAuth: sessionInitiatorAuth,
            taskActivityObserver: taskObserver,
          }),
        );
      } else {
        expect(dispatchToClaimedAgentAddress).toHaveBeenCalledWith(
          expect.objectContaining({ activityObserver: taskObserver, auth: creatorAuth }),
        );
      }
      expect(prepareOwnerAgentInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ serializedContext: planningContext }),
      );
      expect(result).toMatchObject({ serializedContext });
    },
  );

  it("uses an anonymous task's captured auth despite an authenticated receiving turn", async () => {
    const serializedContext = {
      [AuthKey.name]: receiverAuth,
      [InitiatorAuthKey.name]: receiverInitiatorAuth,
      [SessionDynamicSubagentSelectionsKey.name]: { source: "receiver-session" },
      [TurnDynamicSubagentSelectionsKey.name]: { source: "receiver-turn" },
    };
    const planningContext = {
      [AuthKey.name]: null,
      [InitiatorAuthKey.name]: sessionInitiatorAuth,
    };
    const indexedSession = registerWorkflowToolRun(session, {
      callId: "task-1",
      toolName: "research",
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "task-run", hookToken: "task-token" },
      task: {
        dispatchContext: {
          auth: { current: null, initiator: sessionInitiatorAuth },
        },
        metadata: { kind: "subagent", name: "research" },
        taskId: "task-1",
      },
    });
    vi.mocked(readDurableSession).mockReturnValue(indexedSession as never);
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      auth: null,
      initiatorAuth: sessionInitiatorAuth,
      plan: [{ kind: "start", target: { action, kind: "local", source: { type: "runtime" } } }],
      serializedContext: planningContext,
      session: indexedSession,
    } as never);
    vi.mocked(startSubagent).mockResolvedValue(called);

    const result = await dispatchTaskAgentInvocationStep({
      ownerId: "task-1",
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1",
        kind: "agent-invoke",
      },
      serializedContext,
      sessionState: { sessionId: "parent" } as never,
      taskId: "task-1",
    });

    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ auth: null, initiatorAuth: sessionInitiatorAuth }),
    );
    expect(prepareOwnerAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ serializedContext: planningContext }),
    );
    expect(result).toMatchObject({ serializedContext });
  });

  it("rejects missing creator context before dispatching with receiver authentication", async () => {
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: {
        ...session.state,
        "eve.runtime.workflowInvocations": {
          version: 2,
          invocations: [
            {
              callId: "task-1",
              toolName: "research",
              lifetime: "session" as const,
              origin: { turnId: "turn-1", stepIndex: 0 },
              address: { runId: "task-run", hookToken: "task-token" },
              task: {
                metadata: { kind: "subagent", name: "research" },
                taskId: "task-1",
              },
            },
          ],
        },
      },
    } as never);

    await expect(
      dispatchTaskAgentInvocationStep({
        ownerId: "task-1",
        replyTo: "agent-reply",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "call-1",
          kind: "agent-invoke",
        },
        serializedContext: { "eve.auth": receiverAuth },
        sessionState: { sessionId: "parent" } as never,
        taskId: "task-1",
      }),
    ).rejects.toThrow("Corrupt workflow invocation registry");
    expect(prepareOwnerAgentInvocation).not.toHaveBeenCalled();
  });

  it("starts a fresh agent with task-owned handle semantics", async () => {
    const reserved = {
      callId: "call-1",
      identity: { id: "agent-receipt", name: "research", nodeId: "subagents/research" },
      operationId: "receipt-operation",
      phase: "reserved" as const,
      ownerId: "task-1",
    };
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [reserved] }),
    } as never);
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      session: {
        ...session,
        state: setAgentHandleStore(undefined, { handles: [reserved] }),
      },
      plan: [{ kind: "start", target: { action, kind: "local", source: { type: "runtime" } } }],
    } as never);
    vi.mocked(startSubagent).mockResolvedValue(called);

    const dispatched = await dispatch();

    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentContinuationToken: "agent-reply",
        taskId: "task-1",
      }),
    );
    expect(dispatched).toMatchObject({ agentId: "agent-receipt", kind: "dispatched" });
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSession: expect.objectContaining({
          state: expect.objectContaining({
            "eve.agent.handles": { handles: [reserved] },
          }),
        }),
      }),
    );
    expect(getAgentHandleStore(dispatched.sessionState.snapshot.session.state)?.handles).toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: "task-1", phase: "claimed" })]),
    );
  });
});

describe("task-owned agent settlement", () => {
  it.each(
    (["parked", "terminal"] as const).flatMap((kind) =>
      ([undefined, "tool", "subagent"] as const).map((taskKind) => ({ kind, taskKind })),
    ),
  )("applies a $kind child outcome under $taskKind ownership", async ({ kind, taskKind }) => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "operation-1",
      phase: "claimed" as const,
      ownerId: "task-1",
    };
    const owner =
      taskKind === undefined
        ? session
        : registerWorkflowToolRun(session, {
            callId: "call-1",
            toolName: "research",
            lifetime: "session",
            origin: { turnId: "turn", stepIndex: 0 },
            address: { runId: "run", hookToken: "hook" },
            task: {
              taskId: "task-1",
              metadata: { kind: taskKind, name: "research" },
              dispatchContext: { auth: { current: null, initiator: null } },
            },
          });
    vi.mocked(readDurableSession).mockReturnValue({
      ...owner,
      state: setAgentHandleStore(owner.state, { handles: [claimed] }),
    } as never);

    const settled = await settleTaskAgentInvocationStep({
      serializedContext: {},
      result: {
        callId: "call-1",
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind,
          result: { kind: "succeeded", output: "done" },
          usageDelta: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 2,
            outputTokens: 1,
          },
        },
        output: "done",
        subagentName: "research",
      },
      ownerId: "task-1",
      sessionState: {} as never,
      taskId: taskKind === undefined ? undefined : "task-1",
    });

    expect(settled.completion).toEqual(
      taskKind === "subagent"
        ? undefined
        : {
            type: "subagent.completed",
            data: { callId: "call-1", subagentName: "research", output: "done" },
          },
    );
    const handles = getAgentHandleStore(settled.sessionState.snapshot.session.state)?.handles ?? [];
    expect(handles).toEqual(
      kind === "parked" ? [expect.objectContaining({ phase: "available" })] : [],
    );
  });

  it("releases every remaining claim for a completed workflow run", async () => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "operation-1",
      ownerId: "workflow-run-1",
      phase: "claimed" as const,
    };
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    } as never);

    const released = await releaseAgentInvocationOwnerStep({
      ownerId: "workflow-run-1",
      sessionState: {} as never,
    });

    expect(getAgentHandleStore(released.sessionState.snapshot.session.state)?.handles).toEqual([
      availableRecord,
    ]);
  });

  it("parks every remaining claim for a cancelled workflow run", async () => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "operation-1",
      ownerId: "workflow-run-1",
      phase: "claimed" as const,
    };
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    } as never);

    const released = await releaseAgentInvocationOwnerStep({
      cancelled: true,
      ownerId: "workflow-run-1",
      sessionState: {} as never,
    });

    expect(getAgentHandleStore(released.sessionState.snapshot.session.state)?.handles).toEqual([
      {
        address: availableRecord.address,
        identity: availableRecord.identity,
        lastStatus: "(cancelled)",
        phase: "parked",
      },
    ]);
  });

  it("keeps a cancelled parked child resumable after settlement", async () => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "operation-1",
      phase: "claimed" as const,
      ownerId: "workflow-run-1",
    };
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    } as never);

    const settled = await settleTaskAgentInvocationStep({
      serializedContext: {},
      ownerId: "workflow-run-1",
      result: {
        callId: "call-1",
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind: "parked",
          result: { kind: "cancelled" },
          usageDelta: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        output: "cancelled",
        subagentName: "research",
      },
      sessionState: {} as never,
    });

    expect(settled.completion).toBeUndefined();
    expect(getAgentHandleStore(settled.sessionState.snapshot.session.state)?.handles).toEqual([
      {
        address: availableRecord.address,
        identity: availableRecord.identity,
        lastStatus: "(cancelled)",
        phase: "parked",
      },
    ]);
  });
});

async function dispatch() {
  return await dispatchAgentInvocation({
    callbackBaseUrl: "https://parent.example",
    emit: vi.fn(),
    replyTo: "agent-reply",
    request: {
      input: { message: "Find it", target: "research" },
      invocationId: "call-1",
      kind: "agent-invoke",
    },
    ownerId: "task-1",
    serializedContext: {},
    sessionState: {} as never,
    taskId: "task-1",
  });
}
