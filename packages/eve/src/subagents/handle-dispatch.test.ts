import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { dispatchToClaimedAgentAddress } from "./handle-dispatch.js";

vi.mock("#execution/workflow-runtime.js", () => ({ createWorkflowRuntime: vi.fn() }));

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
    parentToken: "reply-token",
  } satisfies Parameters<typeof dispatchToClaimedAgentAddress>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchSession.mockResolvedValue({ status: "accepted" });
    vi.mocked(createWorkflowRuntime).mockReturnValue({ dispatchSession } as never);
  });

  it("supplies a caller when continuing an idle child", async () => {
    await dispatchToClaimedAgentAddress(input);
    expect(dispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          caller: {
            callId: "update-call",
            replyTo: { kind: "hook", token: "reply-token" },
            subagentName: "research",
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
});
