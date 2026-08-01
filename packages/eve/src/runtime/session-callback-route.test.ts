import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import {
  getSessionCallbackChannelDefinitions,
  getSessionCallbackChannelNames,
  handleSessionCallbackRequest,
  HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX,
} from "#runtime/session-callback-route.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("session callback route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it("registers the POST framework callback route", () => {
    expect(getSessionCallbackChannelDefinitions()).toEqual([
      expect.objectContaining({
        method: "POST",
        name: `${HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX}/post`,
        urlPath: EVE_CALLBACK_ROUTE_PATTERN,
      }),
    ]);
  });

  it("uses route-aligned logical names for disableRoute", () => {
    const names = getSessionCallbackChannelNames();
    expect(names).toEqual(new Set([`${HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX}/post`]));
    expect([...names].some((name) => name.startsWith(".well-known/"))).toBe(false);
  });

  it("resumes a completed remote-agent result", async () => {
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
          claim: { kind: "session", sessionId: "remote-session" },
          kind: "subagent-result",
          origin: "child",
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
          claim: { kind: "call-only" },
          kind: "subagent-result",
          origin: "child",
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it("projects reported usage onto the resumed result", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          kind: "session.completed",
          output: "done",
          sessionId: "remote-session",
          subagentName: "research",
          usage: { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 },
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
          claim: { kind: "session", sessionId: "remote-session" },
          kind: "subagent-result",
          origin: "child",
          output: "done",
          subagentName: "research",
          usage: { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 },
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
          claim: { kind: "session", sessionId: "remote-session" },
          kind: "subagent-result",
          origin: "child",
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it("projects a completed conversation turn like a completed task session", async () => {
    resumeHookMock.mockResolvedValue(undefined);

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

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-2",
          claim: { kind: "session", sessionId: "remote-session" },
          kind: "subagent-result",
          origin: "child",
          output: "next result",
          subagentName: "research",
        },
      ],
    });
  });

  it("rejects a turn callback without a sessionId instead of binding by callId", async () => {
    // `turn.*` kinds postdate session claims, so no older deployment can send
    // them; a claim-less turn callback must not inherit the legacy loophole.
    for (const body of [
      { callId: "call-2", kind: "turn.completed", output: "done", subagentName: "research" },
      {
        callId: "call-2",
        error: { code: "X", message: "boom" },
        kind: "turn.failed",
        subagentName: "research",
      },
    ]) {
      const response = await handleSessionCallbackRequest(
        new Request("https://app.example.com/eve/v1/callback/tok123", {
          body: JSON.stringify(body),
          method: "POST",
        }),
        createRouteContext({ token: "tok123" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Missing callback sessionId.",
        ok: false,
      });
    }
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("resumes a failed conversation turn as an error result", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-2",
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "remote failed",
          },
          kind: "turn.failed",
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
          claim: { kind: "session", sessionId: "remote-session" },
          isError: true,
          kind: "subagent-result",
          origin: "child",
          output: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "remote failed",
          },
          subagentName: "research",
        },
      ],
    });
  });
});

function createRouteContext(params: Record<string, string>): RouteContext {
  return {
    agent: {
      async cancelTurn() {
        throw new Error("unexpected cancelTurn");
      },
      async deliver() {
        throw new Error("unexpected deliver");
      },
      async getEventStream() {
        throw new Error("unexpected getEventStream");
      },
      async run() {
        throw new Error("unexpected run");
      },
    },
    params,
    requestIp: null,
    waitUntil() {},
  };
}
