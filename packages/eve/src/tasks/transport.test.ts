import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createTaskRecord } from "#internal/testing/task-records.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resolveRemoteAgentForAction,
} from "#subagents/remote-dispatch.js";
import { deliverToChild, runCommands } from "#tasks/transport.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#subagents/remote-dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  continueRemoteAgentSession: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
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

beforeEach(() => {
  vi.resetAllMocks();
  dispatchSession.mockResolvedValue({ status: "accepted" });
  vi.mocked(createWorkflowRuntime).mockReturnValue({ dispatchSession } as never);
  vi.mocked(resolveRemoteAgentForAction).mockReturnValue({ name: "research" } as never);
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
        payload: { message: "Use Alice's updated requirements", outputSchema: undefined },
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
      outputSchema: undefined,
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
    expect(dispatchSession).not.toHaveBeenCalled();
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
      bundle,
    );

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(cancelRemoteAgentTurn).toHaveBeenCalledExactlyOnceWith({
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
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
        bundle,
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "[eve:tasks.transport] failed to send cancel to a task child",
      expect.objectContaining({ childSessionId: "child-session", taskId: "research-abc234" }),
    );
    error.mockRestore();
  });
});
