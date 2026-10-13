import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  cancelAgentSessionTurnStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
} from "#execution/agent-sessions/steps.js";

const mocks = vi.hoisted(() => ({
  attempt: 1,
  createSession: vi.fn(),
  dispatch: vi.fn(),
  resolveSessionInbox: vi.fn(),
  waitForCommandHookOwner: vi.fn(),
  waitForSessionInbox: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ attempt: mocks.attempt }),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-runtime.js")>()),
  createWorkflowRuntime: () => ({ createSession: mocks.createSession }),
  dispatchWorkflowSessionCommand: mocks.dispatch,
  waitForCommandHookOwner: mocks.waitForCommandHookOwner,
  waitForSessionInbox: mocks.waitForSessionInbox,
}));
vi.mock("#execution/session-inbox/resume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/session-inbox/resume.js")>()),
  resolveSessionInbox: mocks.resolveSessionInbox,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({ graph: {} }),
}));
vi.mock("#runtime/durable-compiled-artifacts-source.js", () => ({
  resolveDurableCompiledArtifactsSource: (source: unknown) => source,
}));
vi.mock("#execution/agent-sessions/target.js", () => {
  const action = { callId: "call-1", name: "reviewer", nodeId: "reviewer" };
  return {
    resolveAgentAction: () => action,
    resolveAgentStartTarget: () => ({ action, kind: "local", source: { type: "declared" } }),
  };
});
vi.mock("#subagents/tool.js", () => ({
  buildSubagentRunInput: (input: { readonly continuationKey: string }) => ({
    childContinuationToken: `subagent:${input.continuationKey}`,
    runInput: {},
  }),
}));

const context = {
  bundle: { source: {} },
  dynamicSelections: {},
  parent: { callId: "call-1", rootSessionId: "parent-1", sessionId: "parent-1" },
  sandbox: {},
  trace: {},
} as AgentSessionContext;

const session = {
  address: {
    continuationToken: "child-continuation",
    kind: "local",
    name: "reviewer",
    nodeId: "reviewer",
    sessionId: "child-1",
  },
  context,
  key: "run-1:0",
} as const;

const message = {
  ...session,
  auth: { current: null, initiator: null },
  message: "Bob asks for a second look at the plan.",
  replyTo: "reply-1",
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attempt = 1;
});

describe("openAgentSessionStep", () => {
  const open = () => openAgentSessionStep({ ...message, name: "reviewer" });

  it("returns the session it started without waiting for the session to boot", async () => {
    mocks.createSession.mockResolvedValue({ sessionId: "child-1" });

    await expect(open()).resolves.toEqual({
      continuationToken: "subagent:run-1:0",
      kind: "local",
      name: "reviewer",
      nodeId: "reviewer",
      sessionId: "child-1",
    });
    expect(mocks.waitForCommandHookOwner).not.toHaveBeenCalled();
  });

  it("returns the run that claimed the session when a retried attempt may have started two", async () => {
    mocks.attempt = 2;
    mocks.createSession.mockResolvedValue({ sessionId: "child-2" });
    mocks.waitForCommandHookOwner.mockResolvedValue({ runId: "child-1" });

    await expect(open()).resolves.toMatchObject({ sessionId: "child-1" });
    expect(mocks.waitForCommandHookOwner).toHaveBeenCalledWith(
      expect.stringContaining("subagent:run-1:0"),
    );
  });
});

describe("commands to a session that opened without waiting", () => {
  it.each([
    {
      command: "send",
      refused: { status: "session_not_active" },
      delivered: { sessionId: "child-1", status: "accepted" },
      run: () => sendAgentSessionMessageStep(message),
    },
    {
      command: "cancel",
      refused: { status: "no_active_turn" },
      delivered: { sessionId: "child-1", status: "accepted" },
      run: () => cancelAgentSessionTurnStep(session),
    },
    {
      command: "reset",
      refused: { status: "no_active_session" },
      delivered: { previousSessionId: "child-1", status: "reset" },
      run: () => endAgentSessionsStep({ sessions: [session] }),
    },
  ])("delivers $command once the session claims its inbox", async (step) => {
    mocks.dispatch.mockResolvedValueOnce(step.refused).mockResolvedValueOnce(step.delivered);
    mocks.waitForSessionInbox.mockResolvedValue(true);

    await step.run();

    expect(mocks.waitForSessionInbox).toHaveBeenCalledWith("child-1");
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenLastCalledWith({
      command: expect.objectContaining({ kind: step.command }),
      sessionId: "child-1",
    });
  });

  it("delivers to the session a duplicate start claimed when the recorded run lost it", async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: "session_not_active" }).mockResolvedValueOnce({
      sessionId: "child-2",
      status: "accepted",
    });
    mocks.waitForSessionInbox.mockResolvedValue(false);
    mocks.resolveSessionInbox.mockResolvedValue({ sessionId: "child-2" });

    await sendAgentSessionMessageStep(message);

    expect(mocks.resolveSessionInbox).toHaveBeenCalledWith("child-continuation");
    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "child-2" }),
    );
  });

  it("fails a message to a session that ended", async () => {
    mocks.dispatch.mockResolvedValue({ status: "session_not_active" });
    mocks.waitForSessionInbox.mockResolvedValue(false);
    mocks.resolveSessionInbox.mockRejectedValue(new HookNotFoundError("child-continuation"));

    await expect(sendAgentSessionMessageStep(message)).rejects.toThrow(
      'Agent "reviewer" can no longer receive messages; its session ended.',
    );
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
});
