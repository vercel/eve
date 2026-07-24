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
          event: {
            kind: "session.completed",
            output: "done",
            status: "termination",
          },
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
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it("resumes a failed remote-agent result with the reported error", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            error: { code: "SESSION_FAILED", message: "remote exploded" },
            kind: "session.failed",
            status: "termination",
          },
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
          output: { code: "SESSION_FAILED", message: "remote exploded" },
          subagentName: "research",
        },
      ],
    });
  });

  it("resumes a notification callback as a subagent authorization event", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            data: {
              authorization: { url: "https://idp.example.com/authorize" },
              description: "Linear workspace access",
              name: "linear",
              sequence: 3,
              stepIndex: 1,
              turnId: "turn-1",
            },
            status: "notification",
            type: "authorization.required",
          },
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      callId: "call-1",
      childSessionId: "remote-session",
      event: {
        data: {
          authorization: { url: "https://idp.example.com/authorize" },
          description: "Linear workspace access",
          name: "linear",
          sequence: 3,
          stepIndex: 1,
          turnId: "turn-1",
        },
        type: "authorization.required",
      },
      kind: "subagent-authorization-event",
      subagentName: "research",
    });
  });

  it("resumes an authorization.completed notification callback", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            data: {
              name: "linear",
              outcome: "authorized",
              sequence: 4,
              stepIndex: 1,
              turnId: "turn-1",
            },
            status: "notification",
            type: "authorization.completed",
          },
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("tok123", {
      callId: "call-1",
      childSessionId: "remote-session",
      event: {
        data: {
          name: "linear",
          outcome: "authorized",
          sequence: 4,
          stepIndex: 1,
          turnId: "turn-1",
        },
        type: "authorization.completed",
      },
      kind: "subagent-authorization-event",
      subagentName: "research",
    });
  });

  it("strips unknown keys from a notification event before resuming", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            data: {
              description: "Linear workspace access",
              futureField: true,
              name: "linear",
              sequence: 3,
              stepIndex: 1,
              turnId: "turn-1",
            },
            status: "notification",
            type: "authorization.required",
          },
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(202);
    const payload = resumeHookMock.mock.calls[0]?.[1] as {
      event: { data: Record<string, unknown> };
    };
    expect(payload.event.data.futureField).toBeUndefined();
    expect(payload.event.data.name).toBe("linear");
  });

  it("rejects a malformed notification event", async () => {
    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            data: { name: "linear" },
            status: "notification",
            type: "authorization.required",
          },
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

  it.each(["working", "input_required", "unknown-status"])(
    "rejects the not-yet-supported callback event status %s",
    async (status) => {
      const response = await handleSessionCallbackRequest(
        new Request("https://app.example.com/eve/v1/callback/tok123", {
          body: JSON.stringify({
            callId: "call-1",
            event: { status },
            sessionId: "remote-session",
            subagentName: "research",
          }),
          method: "POST",
        }),
        createRouteContext({ token: "tok123" }),
      );

      expect(response.status).toBe(400);
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when a notification arrives for a hook that is not pending", async () => {
    resumeHookMock.mockRejectedValue(new Error("no pending hook"));

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            data: {
              description: "Linear workspace access",
              name: "linear",
              sequence: 3,
              stepIndex: 1,
              turnId: "turn-1",
            },
            status: "notification",
            type: "authorization.required",
          },
          sessionId: "remote-session",
          subagentName: "research",
        }),
        method: "POST",
      }),
      createRouteContext({ token: "tok123" }),
    );

    expect(response.status).toBe(404);
  });

  it("projects reported usage onto the resumed result", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    const response = await handleSessionCallbackRequest(
      new Request("https://app.example.com/eve/v1/callback/tok123", {
        body: JSON.stringify({
          callId: "call-1",
          event: {
            kind: "session.completed",
            output: "done",
            status: "termination",
            usage: { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 },
          },
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
          event: {
            kind: "session.completed",
            output: "done",
            status: "termination",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 100,
              outputTokens: 50,
              reasoningOutputTokens: 7,
            },
          },
          sessionId: "remote-session",
          subagentName: "research",
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
          event: {
            kind: "session.completed",
            output: "done",
            status: "termination",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: "lots",
              outputTokens: 50,
            },
          },
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
          output: "done",
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
