import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSubagentReply } from "#subagents/reply.js";
const sendInbox = vi.fn();
const dispatch = vi.fn();
vi.mock("#execution/inbox/send.js", () => ({
  sendInbox: (...args: unknown[]) => sendInbox(...args),
}));
vi.mock("#execution/session/ingress.js", () => ({
  dispatchSessionCommandByToken: (...args: unknown[]) => dispatch(...args),
}));
beforeEach(() => {
  sendInbox.mockReset();
  dispatch.mockReset();
  sendInbox.mockResolvedValue("delivered");
});
describe("subagent reply delivery", () => {
  it("binds an invocation reply to its owner and request and retains retry identity", async () => {
    const target = {
      kind: "inbox" as const,
      address: { token: "opaque", ownerRunId: "owner" },
      requestId: "invocation",
    };
    const payload = { kind: "runtime-action-result" as const, results: [] };
    await sendSubagentReply(target, payload);
    await sendSubagentReply(target, payload);
    expect(sendInbox.mock.calls[0]).toEqual(sendInbox.mock.calls[1]);
    expect(sendInbox).toHaveBeenCalledWith(target.address, {
      kind: "agent.response",
      requestId: "invocation",
      payload,
      eventId: expect.any(String),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("admits replies for a parked session through its stable address", async () => {
    const payload = { kind: "runtime-action-result" as const, results: [] };
    await expect(
      sendSubagentReply({ kind: "session", token: "stable-session" }, payload),
    ).resolves.toBe("delivered");
    expect(dispatch).toHaveBeenCalledWith(
      "stable-session",
      { kind: "runtime", payload },
      expect.any(String),
    );
  });
});
