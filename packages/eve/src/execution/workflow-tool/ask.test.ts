import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, attachWorkflowToolRunContext } from "#execution/workflow-tool/ask.js";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";
import type { ToolContext } from "#tools/definition.js";

const send = vi.hoisted(() => vi.fn());
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: send }));

function context() {
  const replies = new Map<string, (value: InboxEnvelope) => void>();
  const inbox = {
    address: { ownerRunId: "tool-run", token: "tool-owner" },
    response: (requestId: string) =>
      new Promise<InboxEnvelope>((resolve) => replies.set(requestId, resolve)),
  } as OwnerInbox;
  const ctx = { callId: "call", toolName: "deploy" } as ToolContext;
  attachWorkflowToolRunContext(ctx, {
    from: {
      callId: "call",
      execution: "blocking",
      input: {},
      runId: "tool-run",
      sequence: 0,
      stepIndex: 0,
      toolName: "deploy",
      turnId: "turn",
    },
    inbox,
    owner: { ownerRunId: "turn-run", token: "turn-owner" },
  });
  return { ctx, replies };
}

beforeEach(() => {
  send.mockReset().mockResolvedValue("delivered");
});

describe("workflow ask", () => {
  it("returns ordinary promises and correlates overlapping answers through one owner", async () => {
    const { ctx, replies } = context();
    const a = ask(ctx, { prompt: "First?" });
    const b = ask(ctx, { prompt: "Second?" });
    expect(a).toBeInstanceOf(Promise);
    expect(b).toBeInstanceOf(Promise);
    await Promise.resolve();
    const messages = send.mock.calls.map((call) => call[1]);
    expect(messages.map((message) => message.payload.replyTo.address)).toEqual([
      { ownerRunId: "tool-run", token: "tool-owner" },
      { ownerRunId: "tool-run", token: "tool-owner" },
    ]);
    expect(messages[0].payload.replyTo.requestId).not.toBe(messages[1].payload.replyTo.requestId);
    replies.get(messages[1].payload.replyTo.requestId)!({
      eventId: "b",
      kind: "tool.response",
      payload: { text: "second" },
    });
    replies.get(messages[0].payload.replyTo.requestId)!({
      eventId: "a",
      kind: "tool.response",
      payload: { text: "first" },
    });
    await expect(a).resolves.toEqual({ text: "first" });
    await expect(b).resolves.toEqual({ text: "second" });
  });

  it("fails visibly when its owner has ended", async () => {
    send.mockResolvedValue("gone");
    await expect(ask(context().ctx, { prompt: "Continue?" })).rejects.toThrow("owner ended");
  });

  it("requires workflow body context", async () => {
    await expect(ask({} as ToolContext, { prompt: "Continue?" })).rejects.toThrow(
      "workflow tool body",
    );
  });
});
