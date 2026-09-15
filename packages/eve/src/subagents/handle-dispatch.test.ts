import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { dispatchToClaimedAgentAddress } from "./handle-dispatch.js";
import { continueRemoteAgentSession, resolveRemoteAgentForAction } from "./remote-dispatch.js";

vi.mock("#execution/workflow-runtime.js", () => ({ createWorkflowRuntime: vi.fn() }));
vi.mock("#subagents/remote-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  continueRemoteAgentSession: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
}));

describe("claimed child delivery", () => {
  const dispatchSession = vi.fn();
  const input = {
    action: {
      callId: "update-call",
      description: "Research",
      input: { message: "Use Alice's updated requirements" },
      kind: "subagent-call",
      name: "research",
      nodeId: "subagents/research",
      subagentName: "research",
    },
    auth: null,
    bundle: { compiledArtifactsSource: {} } as never,
    currentSession: {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent",
    },
    handle: {
      address: { kind: "agent/local", sessionId: "child", continuationToken: "child-token" },
      identity: { id: "agent", name: "research", nodeId: "subagents/research" },
      operationId: "original-operation",
      callId: "original-call",
      ownerId: "original-task",
      phase: "claimed",
    },
    reply: { kind: "steer" },
  } satisfies Parameters<typeof dispatchToClaimedAgentAddress>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchSession.mockResolvedValue({ status: "accepted" });
    vi.mocked(createWorkflowRuntime).mockReturnValue({ dispatchSession } as never);
  });

  it("steers without replacing the active turn's caller", async () => {
    await expect(dispatchToClaimedAgentAddress(input)).resolves.toMatchObject({ kind: "called" });
    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child",
      command: {
        auth: null,
        caller: undefined,
        kind: "send",
        payload: { message: "Use Alice's updated requirements", outputSchema: undefined },
      },
    });
  });

  it("supplies a new caller when continuing an idle child", async () => {
    await dispatchToClaimedAgentAddress({
      ...input,
      reply: { kind: "reply", parentToken: "reply-token", taskId: "new-task" },
    });
    expect(dispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          caller: {
            callId: "update-call",
            replyTo: { kind: "hook", token: "reply-token" },
            subagentName: "research",
            taskId: "new-task",
          },
        }),
      }),
    );
  });

  it("reports a missing child without starting a replacement", async () => {
    dispatchSession.mockResolvedValueOnce({ status: "session_not_active" });
    await expect(dispatchToClaimedAgentAddress(input)).resolves.toMatchObject({
      kind: "error",
      deliveryPermanent: true,
    });
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  it("steers a remote child without replacing its callback", async () => {
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue({ name: "research" } as never);
    const remoteInput = {
      ...input,
      action: { ...input.action, kind: "remote-agent-call" as const, remoteAgentName: "research" },
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } } as never,
      handle: {
        ...input.handle,
        address: {
          kind: "agent/remote" as const,
          sessionId: "remote-child",
          url: "https://child.example",
          callbackBaseUrl: "https://parent.example",
        },
      },
    };
    await expect(dispatchToClaimedAgentAddress(remoteInput)).resolves.toMatchObject({
      kind: "called",
    });
    expect(continueRemoteAgentSession).toHaveBeenCalledExactlyOnceWith({
      auth: null,
      callback: undefined,
      message: "Use Alice's updated requirements",
      outputSchema: undefined,
      remote: { name: "research", url: "https://child.example" },
      sessionId: "remote-child",
    });
    expect(dispatchSession).not.toHaveBeenCalled();
  });
});
