import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { ownerInboxHookToken, TASK_CALLBACK_ALIAS_PREFIX } from "#tasks/state.js";

const resumeHookMock = vi.fn();
const CALLBACK_TOKEN = sessionInboxHookToken(`${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`);
const CALLBACK_URL = `https://app.example.com/eve/v1/callback/${encodeURIComponent(CALLBACK_TOKEN)}`;

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("session callback route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it.each([
    ["the owner's stable inbox", ownerInboxHookToken("parent-session")],
    ["an unwrapped callback alias", `${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`],
    ["an arbitrary hook token", "tok123"],
  ])("refuses %s without reading the body or resuming a hook", async (_name, token) => {
    const request = new Request("https://app.example.com/eve/v1/callback/x", {
      body: JSON.stringify({
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

  it("reports a callback whose alias no longer has an owner as not pending", async () => {
    resumeHookMock.mockRejectedValue(new Error("hook not found"));

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
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

    expect(response.status).toBe(404);
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it.each(["task.update", "task.input-requested", "task.authorization", "turn.started"])(
    "rejects removed %s callbacks without resuming the caller",
    async (kind) => {
      const response = await handleSessionCallbackRequest(
        new Request(CALLBACK_URL, {
          body: JSON.stringify({
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

  it("accepts a sessionId-less callback from an older eve deployment", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: CALLBACK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(CALLBACK_TOKEN, {
      kind: "runtime-action-result",
      source: { kind: "remote" },
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

  it("synthesizes a terminal failed outcome for session.failed", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const error = { code: "REMOTE_AGENT_FAILED", message: "remote crashed" };
    const response = await handleSessionCallbackRequest(
      new Request(CALLBACK_URL, {
        body: JSON.stringify({
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
          callId: "call-2",
          kind: "turn.completed",
          outcome,
          output: "next result",
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
          kind: "subagent-result",
          origin: "child",
          outcome,
          output: "next result",
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
