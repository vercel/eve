import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, invokeAgent } from "#execution/tools/subagent/invoke-agent.js";
import { attachWorkflowToolRunContext } from "#execution/workflow-tool/ask.js";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";
import type { ToolContext } from "#tools/definition.js";
const send = vi.hoisted(() => vi.fn());
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: send }));

function fixture() {
  const response = vi.fn<OwnerInbox["response"]>();
  const ctx = {
    abortSignal: new AbortController().signal,
    callId: "call",
    toolName: "research",
  } as ToolContext;
  const inbox: OwnerInbox = {
    address: { ownerRunId: "tool-run", token: "tool-token" },
    response,
    claim: async () => ({ kind: "owned" }),
    drain: () => [],
    next: async () => {
      throw new Error("Agent replies must use correlation.");
    },
    observe: () => () => {},
    dispose: async () => {},
  };
  attachWorkflowToolRunContext(ctx, {
    from: {
      callId: "call",
      execution: "background",
      input: {},
      runId: "tool-run",
      sequence: 0,
      stepIndex: 0,
      toolName: "research",
      turnId: "turn",
    },
    inbox,
    owner: { ownerRunId: "task-run", token: "task-token" },
  });
  return { ctx, response };
}
const envelope = (payload: unknown): InboxEnvelope => ({
  eventId: "reply",
  kind: "agent.response",
  payload,
});
const result = (callId: string, output: unknown, origin = "child") =>
  envelope({
    kind: "runtime-action-result",
    results: [{ callId, kind: "subagent-result", origin, output, subagentName: "worker" }],
  });
beforeEach(() => {
  send.mockReset().mockResolvedValue("delivered");
});

describe("workflow agent invocation", () => {
  it("uses the existing inbox and releases an admitted child handle after settlement", async () => {
    const { ctx, response } = fixture();
    response.mockResolvedValueOnce(result("call:worker", "done"));
    await expect(agent(ctx, { key: "worker", target: "worker", message: "Do it" })).resolves.toBe(
      "done",
    );
    expect(response).toHaveBeenCalledWith("call:worker", expect.any(AbortSignal));
    expect(send.mock.calls[0]![1].payload.replyTo).toEqual({
      address: { ownerRunId: "tool-run", token: "tool-token" },
      kind: "inbox",
      requestId: "call:worker",
    });
    expect(send.mock.calls[1]![1].payload.request.kind).toBe("agent-settled");
  });

  it("keeps child input batches addressed to the child session", async () => {
    const { ctx, response } = fixture();
    response
      .mockResolvedValueOnce(
        envelope({
          kind: "subagent-input-request",
          childContinuationToken: "child-session",
          event: {
            requests: [{ requestId: "approval" }],
            turnId: "child-turn",
            stepIndex: 2,
            sequence: 3,
          },
        }),
      )
      .mockResolvedValueOnce(result("invocation", "done"));
    await invokeAgent(ctx, { target: "worker", message: "Do it" }, { invocationId: "invocation" });
    expect(send.mock.calls[1]![1].payload).toMatchObject({
      replyTo: { kind: "session", token: "child-session" },
      request: { kind: "input-batch" },
      requestCoordinates: { turnId: "child-turn", stepIndex: 2, sequence: 3 },
    });
  });

  it("rejects reuse of an invocation key", async () => {
    const { ctx, response } = fixture();
    response.mockResolvedValueOnce(result("call:worker", "done"));
    await agent(ctx, { key: "worker", target: "worker", message: "Do it" });
    await expect(agent(ctx, { key: "worker", target: "worker", message: "Again" })).rejects.toThrow(
      "already used",
    );
  });

  it("propagates a dispatch failure without reporting child settlement", async () => {
    const { ctx, response } = fixture();
    response.mockResolvedValueOnce(
      envelope({
        kind: "runtime-action-result",
        results: [
          {
            callId: "invocation",
            isError: true,
            kind: "subagent-result",
            origin: "dispatch",
            output: "unavailable",
            subagentName: "worker",
          },
        ],
      }),
    );
    await expect(
      invokeAgent(ctx, { target: "worker", message: "Do it" }, { invocationId: "invocation" }),
    ).rejects.toBe("unavailable");
    expect(send).toHaveBeenCalledOnce();
  });
});
