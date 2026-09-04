import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { createCallbackCapability } from "#subagents/callback-capability.js";
import type { InboxReplyTarget } from "#execution/inbox/types.js";
import type { RouteContext } from "#public/definitions/channel.js";

const sendReply = vi.fn();
vi.mock("#subagents/reply.js", () => ({
  sendSubagentReply: (...args: unknown[]) => sendReply(...args),
}));
const target: InboxReplyTarget = {
  kind: "inbox",
  address: { token: "private-owner-token", ownerRunId: "owner-run" },
  requestId: "call-1",
};
const token = createCallbackCapability(target);
const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 4, outputTokens: 2 };
const completed = {
  kind: "turn.completed",
  callId: "call-1",
  subagentName: "researcher",
  output: "done",
  outcome: { kind: "parked", result: { kind: "succeeded", output: "done" }, usageDelta: usage },
};
function context(capability = token): RouteContext {
  return { params: { token: capability }, requestIp: null, waitUntil() {} };
}
function request(body: unknown) {
  return new Request("https://eve.example/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  sendReply.mockReset();
  sendReply.mockResolvedValue("delivered");
});

describe("invocation callback routing", () => {
  it("routes the result to the exact owner and request carried by the capability", async () => {
    expect((await handleSessionCallbackRequest(request(completed), context())).status).toBe(202);
    expect(sendReply).toHaveBeenCalledWith(target, {
      kind: "runtime-action-result",
      results: [
        expect.objectContaining({
          callId: "call-1",
          kind: "subagent-result",
          outcome: completed.outcome,
          output: "done",
          usage,
        }),
      ],
    });
  });
  it("rejects a result addressed to a different invocation", async () => {
    expect(
      (await handleSessionCallbackRequest(request({ ...completed, callId: "call-2" }), context()))
        .status,
    ).toBe(403);
    expect(sendReply).not.toHaveBeenCalled();
  });
  it("rejects a session address or unstructured hook token", async () => {
    for (const invalid of ["eve:session:known:inbox", "private-owner-token", "eve:callback:bad"]) {
      expect(
        (await handleSessionCallbackRequest(request(completed), context(invalid))).status,
      ).toBe(403);
    }
    expect(sendReply).not.toHaveBeenCalled();
  });
  it("reports an owner that ended as no longer pending", async () => {
    sendReply.mockResolvedValueOnce("gone");
    expect((await handleSessionCallbackRequest(request(completed), context())).status).toBe(404);
  });
  it("requires an explicit turn outcome", async () => {
    expect(
      (await handleSessionCallbackRequest(request({ ...completed, outcome: undefined }), context()))
        .status,
    ).toBe(400);
    expect(sendReply).not.toHaveBeenCalled();
  });
  it("routes failure outcomes without converting them to session failure", async () => {
    const error = { code: "MODEL_FAILED", message: "Failed" };
    const body = {
      ...completed,
      kind: "turn.failed",
      error,
      outcome: { kind: "parked", result: { kind: "failed", error }, usageDelta: usage },
    };
    expect((await handleSessionCallbackRequest(request(body), context())).status).toBe(202);
    expect(sendReply).toHaveBeenCalledWith(target, {
      kind: "runtime-action-result",
      results: [expect.objectContaining({ isError: true, output: error, outcome: body.outcome })],
    });
  });
  it.each(["private-owner-token", `task:task_1:${"a".repeat(32)}`])(
    "routes child input requests to the owning invocation at %s",
    async (ownerToken) => {
      const owner = { ...target, address: { ...target.address, token: ownerToken } };
      const body = {
        kind: "task.input-requested",
        callId: "call-1",
        childContinuationToken: "child-alias",
        childSessionId: "child",
        taskId: "task_1",
        subagentName: "researcher",
        event: {
          turnId: "turn-1",
          stepIndex: 0,
          sequence: 1,
          requests: [
            {
              kind: "tool-approval",
              requestId: "question",
              prompt: "Continue?",
              options: [{ id: "approve", label: "Approve" }],
              action: { kind: "tool-call", callId: "tool-1", toolName: "write", input: {} },
            },
          ],
        },
      };
      const response = await handleSessionCallbackRequest(
        request(body),
        context(createCallbackCapability(owner)),
      );
      expect(response.status).toBe(202);
      expect(sendReply).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({
          kind: "subagent-input-request",
          callId: "call-1",
          childContinuationToken: "child-alias",
        }),
      );
    },
  );
  it("bounds callback bodies before parsing", async () => {
    expect(
      (
        await handleSessionCallbackRequest(
          request({ ...completed, output: "x".repeat(1024 * 1024) }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(sendReply).not.toHaveBeenCalled();
  });
});
