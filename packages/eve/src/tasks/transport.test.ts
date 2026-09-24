import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionDynamicSubagentSelectionsKey } from "#context/keys.js";
import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createTaskRecord } from "#internal/testing/task-records.js";
import { cancelRun, getRun, resumeHook } from "#internal/workflow/runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  resolveRemoteAgentForAction,
} from "#subagents/remote/dispatch.js";
import {
  answerRemoteAgentSession,
  continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError,
  readRemoteAgentReport,
} from "#subagents/remote/continue.js";
import { RemoteTaskProtocolError } from "#subagents/remote/protocol.js";
import { encodeTaskCreator } from "#tasks/results.js";
import { ownerInboxHookToken } from "#tasks/state.js";
import {
  answerRemoteTask,
  deliverToChild,
  readRemoteTaskReport,
  runCommands,
  sendAgentMessage,
} from "#tasks/transport.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getWorld: vi.fn(async () => ({})),
  resumeHook: vi.fn(),
}));
vi.mock("#subagents/remote/dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  isRetryableRemoteAgentCancelError: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
}));
vi.mock("#subagents/remote/continue.js", () => ({
  answerRemoteAgentSession: vi.fn(),
  continueRemoteAgentSession: vi.fn(),
  isRetryableRemoteAgentContinueError: vi.fn(),
  readRemoteAgentReport: vi.fn(),
}));

const localChild = {
  continuationToken: "child-token",
  kind: "local" as const,
  sessionId: "child-session",
};
const remoteChild = {
  callbackBaseUrl: "https://parent.example",
  kind: "remote" as const,
  sessionId: "remote-child",
  url: "https://child.example",
};
const action = {
  callId: "update-call",
  description: "Research",
  input: { message: "Use Alice's updated requirements" },
  kind: "subagent-call" as const,
  name: "research",
  nodeId: "subagents/research",
  subagentName: "research",
};
const bundle = {
  compiledArtifactsSource: {},
  subagentRegistry: { subagentsByNodeId: new Map() },
} as never;
const dispatchSession = vi.fn();

function contextWithBundle(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle);
  return ctx;
}

beforeEach(() => {
  vi.resetAllMocks();
  dispatchSession.mockResolvedValue({ status: "accepted" });
  vi.mocked(createWorkflowRuntime).mockReturnValue({ dispatchSession } as never);
  vi.mocked(resolveRemoteAgentForAction).mockReturnValue({ name: "research" } as never);
  vi.mocked(isRetryableRemoteAgentContinueError).mockReturnValue(true);
});

describe("deliverToChild", () => {
  it("gives an idle local agent its next message with the owner as the caller", async () => {
    await expect(
      deliverToChild({
        action,
        auth: null,
        bundle,
        child: localChild,
        record: createTaskRecord({ child: localChild }),
        replyToken: "owner-inbox",
      }),
    ).resolves.toBeUndefined();

    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      command: {
        auth: null,
        caller: {
          activityObserver: undefined,
          callId: "update-call",
          replyTo: { kind: "hook", token: "owner-inbox" },
          subagentName: "research",
        },
        kind: "send",
        // The call's identity, so a resent message is admitted once; it starts
        // the call's turn rather than steering another one.
        operationId: "turn-1:update-call",
        payload: { message: "Use Alice's updated requirements", outputSchema: undefined },
        turnPolicy: "queue",
      },
      sessionId: "child-session",
    });
  });

  it.each([
    [{ status: "session_not_active" }, "is no longer reachable"],
    [{ retryable: true, status: "busy" }, "is temporarily unreachable"],
  ])("reports an undelivered message as AGENT_UNREACHABLE (%j)", async (result, message) => {
    dispatchSession.mockResolvedValueOnce(result);

    const failure = await deliverToChild({
      action,
      auth: null,
      bundle,
      child: localChild,
      record: createTaskRecord({ child: localChild }),
      replyToken: "owner-inbox",
    });

    expect(failure).toMatchObject({
      code: "AGENT_UNREACHABLE",
      message: expect.stringContaining(message),
    });
    expect(dispatchSession).toHaveBeenCalledOnce();
  });

  it("continues a remote agent where it runs, with a callback to the reply token", async () => {
    await expect(
      deliverToChild({
        action: { ...action, kind: "remote-agent-call", remoteAgentName: "research" },
        auth: null,
        bundle,
        child: remoteChild,
        record: createTaskRecord({ child: remoteChild }),
        replyToken: "task-callback:alias",
      }),
    ).resolves.toBeUndefined();

    expect(continueRemoteAgentSession).toHaveBeenCalledExactlyOnceWith({
      activityObserver: undefined,
      auth: null,
      callback: {
        callId: "update-call",
        subagentName: "research",
        token: "task-callback:alias",
        url: expect.stringContaining("https://parent.example"),
      },
      message: "Use Alice's updated requirements",
      operationId: "turn-1:update-call",
      outputSchema: undefined,
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
      turnPolicy: "queue",
    });
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it("fails a continuation START_FAILED when the remote runs another task protocol", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(continueRemoteAgentSession).mockRejectedValueOnce(
      new RemoteTaskProtocolError({ name: "research", remoteVersion: 2 }),
    );

    const failure = await deliverToChild({
      action: { ...action, kind: "remote-agent-call", remoteAgentName: "research" },
      auth: null,
      bundle,
      child: remoteChild,
      record: createTaskRecord({ child: remoteChild }),
      replyToken: "task-callback:alias",
    });

    expect(failure).toEqual({
      code: "START_FAILED",
      message: expect.stringContaining(
        "Upgrade so both deployments use the same task protocol version.",
      ),
    });
    error.mockRestore();
  });
});

describe("runCommands", () => {
  it("cancels started local and remote children and holds nothing for unstarted ones", async () => {
    await runCommands(
      [
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({ child: localChild }),
        },
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({ child: remoteChild }),
        },
        { commands: [{ kind: "cancel" }], kind: "send", record: createTaskRecord() },
      ],
      contextWithBundle(),
    );

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith({
      dynamicRemoteAgent: undefined,
      nodeId: "subagents/research",
      registry: expect.any(Map),
      remoteAgentName: "research",
    });
    expect(cancelRemoteAgentTurn).toHaveBeenCalledExactlyOnceWith({
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
  });

  it("asks a workflow tool run to cancel through its control hook without waiting for it", async () => {
    await runCommands(
      [
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({
            child: { commandToken: "control-hook", kind: "workflow", runId: "run-1" },
            kind: "workflow",
            name: "deploy",
          }),
        },
      ],
      contextWithBundle(),
    );

    expect(resumeHook).toHaveBeenCalledExactlyOnceWith("control-hook", {
      kind: "cancel",
      reason: expect.any(String),
    });
    expect(getRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("cancels a dynamic remote agent with its selected configuration, where it runs", async () => {
    const remoteAgent = {
      description: "Billing.",
      path: "/eve/v1/session",
      url: "https://selected.example",
    };
    const ctx = contextWithBundle();
    ctx.set(SessionDynamicSubagentSelectionsKey, {
      "subagents/research": { kind: "remote", prepared: {} as never, remoteAgent },
    });

    await runCommands(
      [
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({ child: remoteChild }),
        },
      ],
      ctx,
    );

    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicRemoteAgent: remoteAgent }),
    );
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
  });

  it("skips a remote cancel when the owner context cannot be read", async () => {
    await runCommands(
      [
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({ child: remoteChild }),
        },
      ],
      undefined,
    );

    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
  });

  it("tries a remote cancel once more when the first request fails in a way that may clear", async () => {
    vi.mocked(cancelRemoteAgentTurn)
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce({ sessionId: "remote-child", status: "accepted" });
    vi.mocked(isRetryableRemoteAgentCancelError).mockReturnValue(true);

    await runCommands(
      [
        {
          commands: [{ kind: "cancel" }],
          kind: "send",
          record: createTaskRecord({ child: remoteChild }),
        },
      ],
      contextWithBundle(),
    );

    expect(cancelRemoteAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("logs a lost cancel instead of failing the owner step", async () => {
    vi.mocked(requestWorkflowTurnCancellation).mockRejectedValueOnce(new Error("hook unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runCommands(
        [
          {
            commands: [{ kind: "cancel" }],
            kind: "send",
            record: createTaskRecord({ child: localChild }),
          },
        ],
        contextWithBundle(),
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "[eve:tasks.transport] failed to send cancel to a task child",
      expect.objectContaining({ childKind: "local", taskId: "research-abc234" }),
    );
    error.mockRestore();
  });
});

describe("sendAgentMessage", () => {
  const ALICE = {
    attributes: {},
    authenticator: "slack",
    principalId: "U-alice",
    principalType: "user",
  } as const;
  const command = {
    key: "turn-1:call-2",
    kind: "message" as const,
    message: "Also cover the pricing change.",
  };

  it("steers a local agent for its current call, with the owner's key and no new principal", async () => {
    await expect(
      sendAgentMessage({
        callbackAlias: "eve:task-callback:alias",
        command,
        ctx: contextWithBundle(),
        ownerSessionId: "owner-session",
        record: createTaskRecord({ child: localChild }),
      }),
    ).resolves.toBeUndefined();

    // The caller names the generation's own call, so the message joins it or
    // starts that call's next turn. No auth: the child keeps acting as the
    // principal that started it, the only one that may steer it.
    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      command: {
        caller: {
          callId: "call-1",
          replyTo: { kind: "hook", token: ownerInboxHookToken("owner-session") },
          subagentName: "research",
        },
        kind: "send",
        operationId: "turn-1:call-2",
        payload: { message: "Also cover the pricing change." },
        turnPolicy: "steer",
      },
      sessionId: "child-session",
    });
  });

  it("steers a remote agent for its current call where it runs, with the owner's key and callback", async () => {
    await expect(
      sendAgentMessage({
        callbackAlias: "eve:task-callback:alias",
        command,
        ctx: contextWithBundle(),
        ownerSessionId: "owner-session",
        record: createTaskRecord({
          child: remoteChild,
          creator: encodeTaskCreator({ auth: ALICE }),
        }),
      }),
    ).resolves.toBeUndefined();

    // Like a local agent, the remote agent counts the message for the call it
    // answers, or runs it as that call's next turn after answering.
    expect(continueRemoteAgentSession).toHaveBeenCalledExactlyOnceWith({
      auth: ALICE,
      callback: {
        callId: "call-1",
        subagentName: "research",
        token: "eve:inbox:v1:eve:task-callback:alias",
        url: "https://parent.example/eve/v1/callback/eve%3Ainbox%3Av1%3Aeve%3Atask-callback%3Aalias",
      },
      message: "Also cover the pricing change.",
      operationId: "turn-1:call-2",
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
      turnPolicy: "steer",
    });
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it.each([
    ["a local session that ended", localChild, "is no longer reachable"],
    ["a remote session that is unavailable", remoteChild, "is temporarily unreachable"],
  ])("reports %s as AGENT_UNREACHABLE", async (_label, child, message) => {
    dispatchSession.mockResolvedValueOnce({ status: "session_not_active" });
    vi.mocked(continueRemoteAgentSession).mockRejectedValueOnce(new Error("HTTP 503"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = await sendAgentMessage({
      callbackAlias: "eve:task-callback:alias",
      command,
      ctx: contextWithBundle(),
      ownerSessionId: "owner-session",
      record: createTaskRecord({ child }),
    });

    expect(failure).toMatchObject({
      code: "AGENT_UNREACHABLE",
      message: expect.stringContaining(message),
    });
    error.mockRestore();
  });

  it("reports a remote agent on another task protocol version as AGENT_UNREACHABLE", async () => {
    const mismatch = new RemoteTaskProtocolError({ name: "research", remoteVersion: 2 });
    vi.mocked(continueRemoteAgentSession).mockRejectedValueOnce(mismatch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = await sendAgentMessage({
      callbackAlias: "eve:task-callback:alias",
      command,
      ctx: contextWithBundle(),
      ownerSessionId: "owner-session",
      record: createTaskRecord({ child: remoteChild }),
    });

    expect(failure).toEqual({ code: "AGENT_UNREACHABLE", message: mismatch.message });
    expect(mismatch.message).toContain("uses task protocol version 2");
    error.mockRestore();
  });

  it("leaves held messages to flushHeldCommands and runs only cancels", async () => {
    await runCommands(
      [{ commands: [command], kind: "send", record: createTaskRecord({ child: localChild }) }],
      contextWithBundle(),
    );

    expect(dispatchSession).not.toHaveBeenCalled();
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
  });
});

describe("answerRemoteTask", () => {
  const ALICE = {
    attributes: {},
    authenticator: "slack",
    principalId: "U-alice",
    principalType: "user",
  } as const;
  const inputResponses = [{ optionId: "approve", requestId: "req-1" }];
  const BOB = { ...ALICE, principalId: "U-bob" } as const;
  const answer = () =>
    answerRemoteTask({
      auth: BOB,
      ctx: contextWithBundle(),
      inputResponses,
      record: createTaskRecord({ child: remoteChild, creator: encodeTaskCreator({ auth: ALICE }) }),
    });

  it("answers where the agent runs, attributed to the principal that answered", async () => {
    await expect(answer()).resolves.toEqual({ kind: "answered" });

    // Bob answers Alice's agent: an approval policy there checks Bob, while the
    // agent, a delegated session, keeps acting as Alice.
    expect(answerRemoteAgentSession).toHaveBeenCalledExactlyOnceWith({
      auth: BOB,
      inputResponses,
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
  });

  it("keeps an answer that did not reach the remote agent answerable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(answerRemoteAgentSession).mockRejectedValueOnce(new Error("HTTP 503"));

    await expect(answer()).resolves.toEqual({ kind: "retry" });
    error.mockRestore();
  });

  it("fails the task AGENT_SESSION_ENDED when the agent's session is gone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(answerRemoteAgentSession).mockRejectedValueOnce(new Error("HTTP 404"));
    vi.mocked(isRetryableRemoteAgentContinueError).mockReturnValue(false);

    await expect(answer()).resolves.toEqual({
      childEnded: true,
      error: {
        code: "AGENT_SESSION_ENDED",
        message: "The agent's session ended before it replied.",
      },
      kind: "failed",
    });
    error.mockRestore();
  });

  it("fails the task AGENT_UNREACHABLE when the agent speaks another task protocol", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const mismatch = new RemoteTaskProtocolError({ name: "research", remoteVersion: 2 });
    vi.mocked(answerRemoteAgentSession).mockRejectedValueOnce(mismatch);

    await expect(answer()).resolves.toEqual({
      childEnded: false,
      error: { code: "AGENT_UNREACHABLE", message: mismatch.message },
      kind: "failed",
    });
    error.mockRestore();
  });
});

describe("readRemoteTaskReport", () => {
  const report = {
    callId: "call-1",
    kind: "turn.completed",
    outcome: {
      kind: "parked",
      result: { kind: "succeeded", output: "Found it." },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 3, outputTokens: 2 },
    },
    output: "Found it.",
    sessionId: "remote-child",
    steers: 1,
    subagentName: "research",
  };

  it("reads the remote agent's latest report for the current call as its callback result", async () => {
    vi.mocked(readRemoteAgentReport).mockResolvedValueOnce(report);

    const result = await readRemoteTaskReport(
      createTaskRecord({ child: remoteChild }),
      contextWithBundle(),
      "callback-token",
    );

    // The child shows a report only to the holder of the callback it was sent to.
    expect(readRemoteAgentReport).toHaveBeenCalledExactlyOnceWith({
      callId: "call-1",
      callbackToken: "callback-token",
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
    expect(result).toMatchObject({
      callId: "call-1",
      output: "Found it.",
      steers: 1,
      subagentName: "research",
    });
  });

  it.each([
    ["no report", undefined],
    ["another agent's report", { ...report, subagentName: "billing" }],
    ["a malformed report", { callId: "call-1", kind: "turn.completed" }],
  ])("treats %s as unfinished", async (_label, value) => {
    vi.mocked(readRemoteAgentReport).mockResolvedValueOnce(value);

    await expect(
      readRemoteTaskReport(
        createTaskRecord({ child: remoteChild }),
        contextWithBundle(),
        "callback-token",
      ),
    ).resolves.toBeUndefined();
  });
});
