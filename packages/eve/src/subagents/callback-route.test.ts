import { beforeEach, describe, expect, it, vi } from "vitest";

const resumeRunnableHook = vi.hoisted(() => vi.fn());
vi.mock("#execution/session-inbox/owner.js", () => ({ resumeRunnableHook }));

import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import type { RouteContext } from "#public/definitions/channel.js";

const position = { sequence: 1, stepIndex: 0, turnId: "child-turn" };

const AGREED = "https://parent.example.com/eve/v1/callback/parent-hook?eveRemoteProtocol=2";

function post(body: unknown, url = AGREED, token = "parent-hook") {
  return handleSessionCallbackRequest(
    new Request(url, {
      body: JSON.stringify(body),
      method: "POST",
    }),
    { params: { token } } as unknown as RouteContext,
  );
}

const approvalRequest = {
  callId: "delegate",
  childContinuationToken: "child-hook",
  childSessionId: "child-session",
  inputSource: "session",
  kind: "subagent-input-request",
  subagentName: "deployer",
  event: {
    ...position,
    requests: [
      {
        action: { callId: "deploy-call", input: {}, kind: "tool-call", toolName: "deploy" },
        kind: "tool-approval",
        prompt: "Deploy?",
        requestId: "approval-1",
      },
    ],
  },
};

describe("handleSessionCallbackRequest from a protocol 2 child", () => {
  beforeEach(() => {
    resumeRunnableHook.mockReset();
    resumeRunnableHook.mockResolvedValue(undefined);
  });

  it("resumes the pending call with the request read as a v27 relay", async () => {
    const response = await post(approvalRequest);
    expect(response.status).toBe(202);
    expect(resumeRunnableHook).toHaveBeenCalledWith(
      "parent-hook",
      expect.objectContaining({
        callId: "delegate",
        events: [
          expect.objectContaining({
            data: expect.objectContaining({ interactionId: "approval-1" }),
            type: "interaction.opened",
          }),
        ],
        kind: "subagent-interaction",
        route: { childContinuationToken: "child-hook", inputSource: "session" },
      }),
    );
  });

  it("resumes the call with how the child resolved its approval", async () => {
    const response = await post({
      callId: "delegate",
      childSessionId: "child-session",
      event: {
        data: {
          ...position,
          resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approval-1" }],
        },
        type: "input.resolved",
      },
      kind: "subagent-authorization-event",
      subagentName: "deployer",
    });
    expect(response.status).toBe(202);
    expect(resumeRunnableHook).toHaveBeenCalledWith("parent-hook", {
      callId: "delegate",
      childSessionId: "child-session",
      events: [
        {
          data: { interactionId: "approval-1", outcome: "accepted" },
          type: "interaction.settled",
        },
      ],
      kind: "subagent-interaction",
      subagentName: "deployer",
    });
  });

  it("acknowledges an approval's own settlement without waking the call", async () => {
    const response = await post({
      callId: "delegate",
      childSessionId: "child-session",
      event: {
        data: {
          ...position,
          outcome: "approved",
          requestId: "approval-1",
          responderPrincipalId: "alice",
        },
        type: "approval.settled",
      },
      kind: "subagent-authorization-event",
      subagentName: "deployer",
    });
    expect(response.status).toBe(202);
    expect(resumeRunnableHook).not.toHaveBeenCalled();
  });

  it("refuses a malformed protocol 2 callback", async () => {
    const response = await post({ ...approvalRequest, event: { ...position, requests: [] } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid session input callback.",
      ok: false,
    });
    expect(resumeRunnableHook).not.toHaveBeenCalled();
  });

  it("refuses a protocol 2 callback for a parent that never agreed to protocol 2", async () => {
    // A parent run from before v27 would drop the relay, leaving the child waiting unseen; the
    // child's turn fails instead, as it did before.
    for (const url of [
      "https://parent.example.com/eve/v1/callback/parent-hook",
      "https://parent.example.com/eve/v1/callback/parent-hook?eveRemoteProtocol=3",
    ]) {
      const response = await post(approvalRequest, url);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Unsupported callback kind.",
        ok: false,
      });
    }
    expect(resumeRunnableHook).not.toHaveBeenCalled();
  });

  it("still refuses protocol 1 task callbacks, which it doesn't translate", async () => {
    const response = await post({ ...approvalRequest, kind: "task.input-requested" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unsupported callback kind.",
      ok: false,
    });
  });

  it("answers 404 when the call is no longer pending", async () => {
    resumeRunnableHook.mockRejectedValue(new Error("hook not found"));
    const response = await post(approvalRequest);
    expect(response.status).toBe(404);
  });
});
