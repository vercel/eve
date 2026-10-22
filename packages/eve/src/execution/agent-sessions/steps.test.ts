import { beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  cancelAgentSessionTurnStep,
  continueAgentSessionsUsageStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  type OpenedAgentSession,
} from "#execution/agent-sessions/steps.js";

const mocks = vi.hoisted(() => ({
  attempt: 1,
  createSession: vi.fn(),
  dispatch: vi.fn(),
  resolveSessionInbox: vi.fn(),
  resumeSessionInbox: vi.fn(),
  runtimeConfig: undefined as unknown,
  targetKind: "local" as "local" | "remote",
  waitForCommandHookOwner: vi.fn(),
  waitForSessionInbox: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ attempt: mocks.attempt }),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-runtime.js")>()),
  createWorkflowRuntime: (config: unknown) => {
    mocks.runtimeConfig = config;
    return { createSession: mocks.createSession };
  },
  dispatchWorkflowSessionCommand: mocks.dispatch,
  waitForCommandHookOwner: mocks.waitForCommandHookOwner,
  waitForSessionInbox: mocks.waitForSessionInbox,
}));
vi.mock("#execution/session-inbox/resume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/session-inbox/resume.js")>()),
  resolveSessionInbox: mocks.resolveSessionInbox,
  resumeSessionInbox: mocks.resumeSessionInbox,
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
    resolveAgentStartTarget: () =>
      mocks.targetKind === "remote"
        ? { action, kind: "remote" }
        : { action, kind: "local", source: { type: "declared" } },
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
  mocks.runtimeConfig = undefined;
  mocks.targetKind = "local";
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

  it("binds a model override to the local child runtime", async () => {
    mocks.createSession.mockResolvedValue({ sessionId: "child-1" });

    await openAgentSessionStep({
      ...message,
      model: {
        model: "anthropic/claude-opus-5.5",
        modelContextWindowTokens: 200_000,
        reasoning: "high",
      },
      name: "reviewer",
    });

    expect(mocks.runtimeConfig).toMatchObject({
      agentSessionRuntimeOverrides: {
        model: {
          contextWindowTokens: 200_000,
          id: "anthropic/claude-opus-5.5",
          reasoning: "high",
        },
      },
    });
  });

  it("rejects a model override for a remote target without retrying", async () => {
    mocks.targetKind = "remote";

    await expect(
      openAgentSessionStep({
        ...message,
        model: "anthropic/claude-opus-5.5",
        name: "reviewer",
      }),
    ).rejects.toBeInstanceOf(FatalError);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid model selection without retrying", async () => {
    await expect(
      openAgentSessionStep({
        ...message,
        model: "",
        name: "reviewer",
      }),
    ).rejects.toBeInstanceOf(FatalError);
    expect(mocks.createSession).not.toHaveBeenCalled();
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

describe("continueAgentSessionsUsageStep", () => {
  const opened = (sessionId: string): OpenedAgentSession => ({
    address: {
      continuationToken: `${sessionId}-token`,
      kind: "local",
      name: "worker",
      nodeId: "worker",
      sessionId,
    },
    context: {} as AgentSessionContext,
    key: sessionId,
  });

  // A session that misses the push asks once itself, so nothing waits or retries.
  it("tells every live session once, skipping one that ended and one it can't reach", async () => {
    mocks.resumeSessionInbox.mockReset();
    mocks.resumeSessionInbox
      .mockRejectedValueOnce(new HookNotFoundError("ended-token"))
      .mockRejectedValueOnce(new Error("inbox unavailable"))
      .mockResolvedValueOnce({});

    await continueAgentSessionsUsageStep({
      requestIds: ["asker:0:limit:usage:0"],
      sessions: [opened("ended"), opened("unreachable"), opened("live")],
    });

    const sent = { kind: "usage-continued", requestIds: ["asker:0:limit:usage:0"] };
    expect(mocks.resumeSessionInbox.mock.calls).toEqual([
      ["ended-token", sent],
      ["unreachable-token", sent],
      ["live-token", sent],
    ]);
    expect(mocks.waitForSessionInbox).not.toHaveBeenCalled();
  });
});
