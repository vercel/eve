import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteContext } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#execution/session-callback-route.js";

const resumeHookMock = vi.fn();
const TASK_ID = "task_1";
const TASK_TOKEN = `task:${TASK_ID}:0123456789abcdef0123456789abcdef`;

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("session callback route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it("forwards remote task turn-start identity to the task hook", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const response = await handleSessionCallbackRequest(
      new Request(`https://app.example.com/eve/v1/callback/${TASK_TOKEN}`, {
        body: JSON.stringify({
          callId: "call-task",
          kind: "turn.started",
          sessionId: "child-session",
          subagentName: "research",
          taskId: TASK_ID,
          turnId: "turn_child_7",
        }),
        method: "POST",
      }),
      createRouteContext({ token: TASK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(TASK_TOKEN, {
      childSessionId: "child-session",
      childTurnId: "turn_child_7",
      kind: "turn-started",
      taskId: TASK_ID,
    });
  });

  it("forwards remote task input requests to the owning task hook", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const event = {
      requests: [
        {
          action: {
            callId: "release-call",
            input: { marker: "RELEASE" },
            kind: "tool-call",
            toolName: "release",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "reject", label: "Reject" },
          ],
          requestId: "req-1",
          prompt: "Approve release",
        },
      ],
      sequence: 3,
      stepIndex: 2,
      turnId: "turn-child",
    };
    const response = await handleSessionCallbackRequest(
      new Request(`https://app.example.com/eve/v1/callback/${TASK_TOKEN}`, {
        body: JSON.stringify({
          callId: "call-task",
          childContinuationToken: "remote-child-token",
          childSessionId: "child-session",
          event,
          kind: "task.input-requested",
          subagentName: "research",
          taskId: TASK_ID,
        }),
        method: "POST",
      }),
      createRouteContext({ token: TASK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(TASK_TOKEN, {
      callId: "call-task",
      childContinuationToken: "remote-child-token",
      childSessionId: "child-session",
      event,
      kind: "subagent-input-request",
      subagentName: "research",
    });
  });

  it("forwards remote task updates to the owning task hook", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const response = await handleSessionCallbackRequest(
      new Request(`https://app.example.com/eve/v1/callback/${TASK_TOKEN}`, {
        body: JSON.stringify({
          callId: "update-call",
          updateIndex: 2,
          updateEpoch: "turn-child",
          kind: "task.update",
          message: "Found three matching records.",
          taskId: TASK_ID,
        }),
        method: "POST",
      }),
      createRouteContext({ token: TASK_TOKEN }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(TASK_TOKEN, {
      callId: "update-call",
      updateIndex: 2,
      updateEpoch: "turn-child",
      kind: "task-update",
      message: "Found three matching records.",
    });
  });

  it.each([
    ["parent turn token", "turn-inbox", TASK_ID],
    ["different task token", TASK_TOKEN, "task_other"],
  ])("rejects task events carried by a %s", async (_label, token, taskId) => {
    const response = await handleSessionCallbackRequest(
      new Request(`https://app.example.com/eve/v1/callback/${token}`, {
        body: JSON.stringify({
          kind: "turn.started",
          sessionId: "child-session",
          taskId,
          turnId: "turn-child",
        }),
        method: "POST",
      }),
      createRouteContext({ token }),
    );

    expect(response.status).toBe(403);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("synthesizes a terminal outcome envelope for session.completed", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          error,
          kind: "session.failed",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
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
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
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
      createRouteContext({ token: "tok123" }),
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
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
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
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
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-2",
          kind: "turn.completed",
          output: "next result",
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
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
      new Request("https://app.example.com/eve/v1/callback/tok123", {
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
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
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
