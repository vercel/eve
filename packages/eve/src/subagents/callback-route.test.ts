import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { isSessionHandoffPending } from "#execution/session-inbox/resume.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { ownerInboxHookToken, TASK_CALLBACK_ALIAS_PREFIX } from "#tasks/state.js";

const resumeHookMock = vi.fn();
const CALLBACK_TOKEN = sessionInboxHookToken(`${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`);
const CALLBACK_URL = `https://app.example.com/eve/v1/callback/${encodeURIComponent(CALLBACK_TOKEN)}`;

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));
vi.mock("#execution/session-inbox/resume.js", () => ({ isSessionHandoffPending: vi.fn() }));

describe("session callback route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    vi.mocked(isSessionHandoffPending).mockReset().mockResolvedValue(false);
  });

  it.each([
    ["the owner's stable inbox", ownerInboxHookToken("parent-session")],
    ["an unwrapped callback alias", `${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`],
    ["an arbitrary hook token", "tok123"],
  ])("refuses %s without reading the body or resuming a hook", async (_name, token) => {
    const request = new Request("https://app.example.com/eve/v1/callback/x", {
      body: JSON.stringify({
        taskProtocol: 1,
        callId: "call-1",
        kind: "session.completed",
        output: "done",
        subagentName: "research",
      }),
      method: "POST",
    });

    const response = await handleSessionCallbackRequest(request, createRouteContext({ token }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session callback not pending.",
      ok: false,
    });
    expect(request.bodyUsed).toBe(false);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("answers a callback no owner can take any more as a duplicate, never 404", async () => {
    resumeHookMock.mockRejectedValue(new HookNotFoundError("hook not found"));

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ duplicate: true, ok: true });
    expect(resumeHookMock).toHaveBeenCalledOnce();
    expect(isSessionHandoffPending).toHaveBeenCalledExactlyOnceWith(
      `${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`,
    );
  });

  it("asks the child to retry while the owner session moves to another deployment", async () => {
    resumeHookMock.mockRejectedValue(new HookNotFoundError("hook not found"));
    vi.mocked(isSessionHandoffPending).mockResolvedValue(true);

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(503);
  });

  it("passes a remote child's input request to its owner as a remote-sourced proxy request", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const event = {
      requests: [
        {
          action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "refund" },
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
          prompt: "Approve refund?",
          requestId: "req-1",
        },
      ],
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_0",
    };

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          event,
          kind: "input.requested",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      callId: "call-1",
      childContinuationToken: "eve:remote-child:remote-session",
      childSessionId: "remote-session",
      event,
      kind: "subagent-input-request",
      source: { kind: "remote" },
      subagentName: "research",
    });
  });

  it("passes a remote child's authorization event to its owner", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const event = {
      data: { attemptId: "a-1", connection: "github", sequence: 1, turnId: "turn_0" },
      type: "authorization.required",
    };

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          event,
          kind: "authorization.event",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      callId: "call-1",
      childSessionId: "remote-session",
      event,
      kind: "subagent-authorization-event",
      source: { kind: "remote" },
      subagentName: "research",
    });
  });

  it.each([
    ["without its session", { event: { requests: [] }, kind: "input.requested" }],
    [
      "with no requests",
      {
        event: { requests: [], sequence: 0, stepIndex: 0, turnId: "t" },
        kind: "input.requested",
        sessionId: "s",
      },
    ],
    [
      "with an unknown event type",
      {
        event: { data: {}, type: "message.completed" },
        kind: "authorization.event",
        sessionId: "s",
      },
    ],
  ])("rejects an input callback %s", async (_label, body) => {
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          callId: "call-1",
          subagentName: "research",
          taskProtocol: 1,
          ...body,
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it.each(["task.update", "task.input-requested", "task.authorization", "turn.started"])(
    "rejects removed %s callbacks without resuming the caller",
    async (kind) => {
      const response = await handleSessionCallbackRequest(
        new Request(CALLBACK_URL, {
          body: JSON.stringify({
            taskProtocol: 1,
            callId: "update-call",
            kind,
            sessionId: "child-session",
            subagentName: "research",
            taskId: "task_1",
            turnId: "turn-child",
          }),
          method: "POST",
        }),
        createRouteContext({ token: CALLBACK_TOKEN }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Unsupported callback kind.",
        ok: false,
      });
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );

  it("synthesizes a terminal outcome envelope for session.completed", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { kind: "succeeded", output: "done" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it.each([
    ["no version, as an older eve sends", {}, "sent no task protocol version"],
    ["another version", { taskProtocol: 2 }, "sent task protocol version 2"],
  ])("refuses a callback with %s, which this owner cannot apply", async (_label, version, sent) => {
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          subagentName: "research",
          ...version,
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TASK_PROTOCOL_MISMATCH",
      error: expect.stringContaining(`the remote agent ${sent}`),
      taskProtocol: 1,
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("synthesizes a terminal failed outcome for session.failed", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const error = { code: "REMOTE_AGENT_FAILED", message: "remote crashed" };
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          error,
          kind: "session.failed",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { error, kind: "failed" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: error,
          subagentName: "research",
        },
      ],
    });
  });

  it("projects reported usage onto the resumed result and its outcome delta", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const usage = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
          usage,
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { kind: "succeeded", output: "done" },
            usageDelta: usage,
          },
          output: "done",
          subagentName: "research",
          usage,
        },
      ],
    });
  });

  it("strips unknown usage keys from a newer callee", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
          usage: {
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            inputTokens: 100,
            outputTokens: 50,
            reasoningOutputTokens: 7,
          },
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    const payload = resumeHookMock.mock.calls[0]?.[1] as {
      results: readonly { usage?: unknown }[];
    };
    expect(payload.results[0]?.usage).toEqual({
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("drops malformed usage but still resumes the result", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
          usage: {
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            inputTokens: "lots",
            outputTokens: 50,
          },
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { kind: "succeeded", output: "done" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it("resumes a completed conversation turn with its outcome envelope", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const outcome = {
      kind: "parked",
      result: { kind: "succeeded", output: "next result" },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 25, outputTokens: 10 },
    };
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          answer: 6,
          callId: "call-2",
          kind: "turn.completed",
          outcome,
          output: "next result",
          sessionId: "remote-session",
          steers: 2,
          subagentName: "research",
          taskProtocol: 1,
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    // The steering messages the child received for the call, and the answer's
    // place among its answers, travel with its answer.
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          answer: 6,
          callId: "call-2",
          kind: "subagent-result",
          origin: "child",
          outcome,
          output: "next result",
          steers: 2,
          subagentName: "research",
          usage: outcome.usageDelta,
        },
      ],
    });
  });

  it("rejects a turn callback without an outcome envelope", async () => {
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-2",
          kind: "turn.completed",
          output: "next result",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("resumes a failed conversation turn as an error result carrying its outcome", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const error = {
      code: "SUBAGENT_EXECUTION_FAILED",
      message: "remote failed",
    };
    const outcome = {
      kind: "terminal",
      result: { error, kind: "failed" },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    };
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          taskProtocol: 1,
          callId: "call-2",
          error,
          kind: "turn.failed",
          outcome,
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote", sessionId: "remote-session" },
      results: [
        {
          callId: "call-2",
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome,
          output: error,
          subagentName: "research",
        },
      ],
    });
  });
});

function createRouteContext(params: Record<string, string>): RouteContext {
  return {
    params,
    requestIp: null,
    waitUntil() {},
  };
}
