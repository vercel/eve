import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionDynamicSubagentSelectionsKey } from "#context/keys.js";
import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createTaskRecord } from "#internal/testing/task-records.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
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
