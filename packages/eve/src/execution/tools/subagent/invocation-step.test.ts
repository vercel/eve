import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchAgentInvocation,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invocation-step.js";
import { dispatchToTaskAgentAddress } from "#subagents/handle-dispatch.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invocation-preparation.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";

vi.mock("#subagents/handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchToTaskAgentAddress: vi.fn(),
}));
vi.mock("#subagents/continuation-bundle.js", () => ({
  createAgentContinuationBundle: vi.fn(() => ({ nodeId: "child" })),
}));
vi.mock("#execution/tools/subagent/start.js", () => ({
  startSubagent: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invocation-preparation.js", () => ({
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
  vi.mocked(readDurableSession).mockResolvedValue(session as never);
});

describe("owner agent invocation dispatch", () => {
  it("resumes an addressed agent through its owning task", async () => {
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      plan: [{ action, agentId: "agent-1", kind: "resume" }],
    } as never);
    vi.mocked(dispatchToTaskAgentAddress).mockResolvedValue(called);

    const dispatched = await dispatch();

    expect(dispatchToTaskAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          identity: availableRecord.identity,
          phase: "claimed",
          taskId: "task-1",
        }),
        parentToken: "agent-reply",
        taskId: "task-1",
      }),
    );
    expect(dispatched).toMatchObject({ agentId: "agent-1" });
    expect(getAgentHandleStore(dispatched.sessionState.snapshot?.session.state)?.handles).toEqual([
      expect.objectContaining({
        identity: availableRecord.identity,
        phase: "claimed",
        taskId: "task-1",
      }),
    ]);
  });

  it("reuses a continuation claim admitted before the workflow body starts", async () => {
    const claimed = {
      ...availableRecord,
      callId: "call-1",
      operationId: "admission-operation",
      phase: "claimed" as const,
      taskId: "task-1",
    };
    const claimedSession = {
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    };
    vi.mocked(readDurableSession).mockResolvedValue(claimedSession as never);
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
      session: claimedSession,
      plan: [{ action, agentId: "agent-1", kind: "resume" }],
    } as never);
    vi.mocked(dispatchToTaskAgentAddress).mockResolvedValue(called);

    await dispatch();

    expect(dispatchToTaskAgentAddress).toHaveBeenCalledWith(
      expect.objectContaining({ handle: claimed }),
    );
  });

  it("starts a fresh agent with task-owned handle semantics", async () => {
    const reserved = {
      callId: "call-1",
      identity: { id: "agent-receipt", name: "research", nodeId: "subagents/research" },
      operationId: "receipt-operation",
      phase: "reserved" as const,
      taskId: "task-1",
    };
    vi.mocked(readDurableSession).mockResolvedValue({
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
    expect(dispatched).toMatchObject({ agentId: "agent-receipt" });
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSession: expect.objectContaining({
          state: expect.objectContaining({
            "eve.agent.handles": { handles: [reserved] },
          }),
        }),
      }),
    );
    expect(getAgentHandleStore(dispatched.sessionState.snapshot?.session.state)?.handles).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "claimed", taskId: "task-1" })]),
    );
  });
});

describe("task-owned agent settlement", () => {
  it.each(["parked", "terminal"] as const)("applies a %s child outcome", async (kind) => {
    const claimed = {
      ...availableRecord,
      operationId: "operation-1",
      phase: "claimed" as const,
      taskId: "task-1",
    };
    vi.mocked(readDurableSession).mockResolvedValue({
      ...session,
      state: setAgentHandleStore(undefined, { handles: [claimed] }),
    } as never);

    const settled = await settleTaskAgentInvocationStep({
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
      sessionState: {} as never,
      taskId: "task-1",
    });

    const handles =
      getAgentHandleStore(settled.sessionState.snapshot?.session.state)?.handles ?? [];
    expect(handles).toEqual(
      kind === "parked" ? [expect.objectContaining({ phase: "available" })] : [],
    );
  });
});

async function dispatch() {
  return await dispatchAgentInvocation({
    emit: vi.fn(),
    replyTo: "agent-reply",
    request: {
      input: { message: "Find it", target: "research" },
      invocationId: "call-1",
      kind: "effect",
      name: "agent.invoke",
    },
    serializedContext: {},
    sessionState: {} as never,
    taskId: "task-1",
  });
}
