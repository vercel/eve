import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteContext } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("session callback route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
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
