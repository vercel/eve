import { beforeEach, describe, expect, it, vi } from "vitest";

const resumeRunnableHook = vi.hoisted(() => vi.fn());
vi.mock("#execution/session-inbox/owner.js", () => ({ resumeRunnableHook }));

import { handleSessionCallbackRequest } from "#subagents/callback-route.js";

const position = { sequence: 1, stepIndex: 0, turnId: "child-turn" };

const AGREED = "https://parent.example.com/eve/v1/callback/parent-hook?eveRemoteProtocol=2";

function post(body: unknown, url = AGREED, token = "parent-hook") {
  return handleSessionCallbackRequest(
    new Request(url, {
      body: JSON.stringify(body),
      method: "POST",
    }),
    { params: { token }, requestIp: null, waitUntil: () => {} },
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

  it("passes a protocol 2 callback as is to a parent run from before v27", async () => {
    // Its URL names no protocol: the run reads protocol 2 input itself, as its own deployment's
    // route passed it, so the child's request reaches it across the parent's upgrade.
    const nested = {
      ...approvalRequest,
      remote: {
        name: "grandchild",
        sessionId: "grandchild-session",
        url: "https://grandchild.example.com",
      },
    };
    const response = await post(nested, "https://parent.example.com/eve/v1/callback/parent-hook");
    expect(response.status).toBe(202);
    expect(resumeRunnableHook).toHaveBeenCalledWith("parent-hook", nested);

    resumeRunnableHook.mockClear();
    const approved = {
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
    };
    await post(approved, "https://parent.example.com/eve/v1/callback/parent-hook");
    // Such a run reads an approval's own settlement too.
    expect(resumeRunnableHook).toHaveBeenCalledWith("parent-hook", approved);
  });

  it("refuses protocol 2 input on a URL that agreed to another protocol", async () => {
    const response = await post(
      approvalRequest,
      "https://parent.example.com/eve/v1/callback/parent-hook?eveRemoteProtocol=3",
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unsupported callback kind.",
      ok: false,
    });
    expect(resumeRunnableHook).not.toHaveBeenCalled();
  });

  it("refuses a malformed protocol 2 callback to a parent run from before v27", async () => {
    const response = await post(
      { ...approvalRequest, event: { ...position, requests: [] } },
      "https://parent.example.com/eve/v1/callback/parent-hook",
    );
    expect(response.status).toBe(400);
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
    // The same message as every protocol's route, now with a code a child can read.
    await expect(response.json()).resolves.toEqual({
      code: "CALLBACK_NOT_PENDING",
      error: "Session callback not pending.",
      ok: false,
    });
  });
});
