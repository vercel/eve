import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchAgentInvocation } from "#execution/tools/subagent/invocation-step.js";
import { dispatchToTaskAgentAddress } from "#execution/agent-handle-dispatch.js";
import { startSubagent } from "#execution/coordination-dispatch-shared.js";
import {
  readAgentHandleStoreStep,
  sendAgentHandleCommandStep,
} from "#execution/session-command-inbox.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invocation-preparation.js";

vi.mock("#execution/agent-handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchToTaskAgentAddress: vi.fn(),
}));
vi.mock("#execution/agent-continuation-bundle.js", () => ({
  createAgentContinuationBundle: vi.fn(() => ({ nodeId: "child" })),
}));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({
  startSubagent: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invocation-preparation.js", () => ({
  prepareOwnerAgentInvocation: vi.fn(),
}));
vi.mock("#execution/session-command-inbox.js", () => ({
  readAgentHandleStoreStep: vi.fn(),
  sendAgentHandleCommandStep: vi.fn(),
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
const session = { sessionId: "parent", state: undefined } as never;
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
  session,
  toolName: "research",
};
const availableRecord = {
  address: called.address,
  identity: { id: "agent-1", name: "research", nodeId: "subagents/research" },
  phase: "available" as const,
};
const claimedRecord = {
  ...availableRecord,
  operationId: "operation-1",
  phase: "claimed" as const,
  taskId: "task-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readAgentHandleStoreStep).mockResolvedValue({ handles: [availableRecord] });
  vi.mocked(sendAgentHandleCommandStep).mockImplementation(async ({ command, commandId }) => ({
    commandId,
    result:
      command.kind === "reserve"
        ? {
            handle: {
              identity: command.identity,
              operationId: command.operationId,
              phase: "reserved",
              taskId: command.taskId,
            },
            kind: "ready",
          }
        : { handle: claimedRecord, kind: "ready" },
    store: { handles: [claimedRecord] },
  }));
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
        parentToken: "agent-reply",
        handle: claimedRecord,
        taskId: "task-1",
      }),
    );
    expect(dispatched).toEqual({ agentId: "agent-1" });
  });

  it("starts a fresh agent with task-owned handle semantics", async () => {
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      ...prepared,
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
    expect(dispatched).toEqual({ agentId: expect.any(String) });
  });
});

async function dispatch() {
  return await dispatchAgentInvocation({
    emit: vi.fn(),
    replyTo: "agent-reply",
    request: {
      input: { message: "Find it", target: "research" },
      invocationId: "call-1",
      kind: "effect" as const,
      name: "agent.invoke" as const,
    },
    serializedContext: {},
    sessionState: {} as never,
    taskId: "task-1",
  });
}
