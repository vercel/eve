import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs, SendFn } from "#channel/routes.js";
import type { Session as ChannelSession } from "#channel/session.js";
import { none } from "#public/channels/auth.js";
import { realtimeSpeechChannel } from "#public/channels/realtime-speech.js";

function makeStream(events: readonly unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

function createRouteHarness(input: Parameters<typeof realtimeSpeechChannel>[0]) {
  const channel = realtimeSpeechChannel(input);
  const send = vi.fn<SendFn>();
  const args: RouteHandlerArgs = {
    send,
    getSession: vi.fn(),
    receive: vi.fn() as any,
    params: {},
    waitUntil: () => undefined,
    requestIp: "127.0.0.1",
  };

  return {
    args,
    send,
    route(method: string, path: string) {
      const route = channel.routes.find(
        (candidate) => candidate.method === method && candidate.path === path,
      );
      if (route === undefined) throw new Error(`Missing route ${method} ${path}`);
      return route;
    },
  };
}

describe("realtimeSpeechChannel", () => {
  it("mints a Gateway realtime token and returns the voice session id", async () => {
    const getToken = vi.fn(async () => ({
      expiresAt: 1_700_000_060,
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
    }));
    const harness = createRouteHarness({
      auth: none(),
      basePath: "/voice",
      createVoiceSessionId: () => "voice-session-1",
      expiresAfterSeconds: 120,
      getToken,
    });

    const route = harness.route("POST", "/voice/setup");
    const response = await (route as any).handler(
      new Request("http://localhost/voice/setup"),
      harness.args,
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getToken).toHaveBeenCalledWith({
      expiresAfterSeconds: 120,
      model: "openai/gpt-realtime-2",
    });
    expect(body).toMatchObject({
      expiresAt: 1_700_000_060,
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
      voiceSessionId: "voice-session-1",
    });
    expect(body.tools).toBeUndefined();
  });

  it("runs one Ash turn on the long-lived voice continuation token", async () => {
    const harness = createRouteHarness({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });
    const streamEvents = [
      { type: "turn.started", data: { sequence: 1, turnId: "turn-1" } },
      {
        type: "message.appended",
        data: {
          messageDelta: "Hello",
          messageSoFar: "Hello",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: " there",
          messageSoFar: "Hello there",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    const session: ChannelSession = {
      continuationToken: "voice-session-1",
      id: "session-1",
      getEventStream: vi.fn(async (options?: { startIndex?: number }) => {
        expect(options?.startIndex).toBe(5);
        return makeStream(streamEvents);
      }),
    };
    harness.send.mockResolvedValue(session);

    const route = harness.route("POST", "/voice/turn");
    const response = await (route as any).handler(
      new Request("http://localhost/voice/turn", {
        body: JSON.stringify({
          context: ["User is speaking over a realtime audio session."],
          message: "Can you help?",
          sessionId: "session-1",
          streamIndex: 5,
          voiceSessionId: "voice-session-1",
        }),
        method: "POST",
      }),
      harness.args,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(harness.send).toHaveBeenCalledWith(
      {
        context: ["User is speaking over a realtime audio session."],
        message: "Can you help?",
      },
      expect.objectContaining({
        continuationToken: "voice-session-1",
        mode: "conversation",
      }),
    );
    expect(body).toEqual({
      ok: true,
      continuationToken: "voice-session-1",
      sessionId: "session-1",
      streamIndex: 9,
      text: "Hello there",
      voiceSessionId: "voice-session-1",
    });
  });

  it("resets the event stream cursor when Eve starts a replacement session", async () => {
    const harness = createRouteHarness({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });
    const session: ChannelSession = {
      continuationToken: "voice-session-1",
      id: "session-new",
      getEventStream: vi.fn(async (options?: { startIndex?: number }) => {
        expect(options?.startIndex).toBe(0);
        return makeStream([
          {
            type: "message.completed",
            data: {
              finishReason: "stop",
              message: "Fresh session reply",
              sequence: 1,
              stepIndex: 0,
              turnId: "turn-new",
            },
          },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]);
      }),
    };
    harness.send.mockResolvedValue(session);

    const route = harness.route("POST", "/voice/turn");
    const response = await (route as any).handler(
      new Request("http://localhost/voice/turn", {
        body: JSON.stringify({
          message: "Continue after restart",
          sessionId: "session-old",
          streamIndex: 12,
          voiceSessionId: "voice-session-1",
        }),
        method: "POST",
      }),
      harness.args,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      sessionId: "session-new",
      streamIndex: 2,
      text: "Fresh session reply",
    });
  });

  it("includes later completed messages after an initial streamed pre-tool response", async () => {
    const harness = createRouteHarness({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });
    const session: ChannelSession = {
      continuationToken: "voice-session-1",
      id: "session-1",
      getEventStream: vi.fn(async () =>
        makeStream([
          { type: "turn.started", data: { sequence: 1, turnId: "turn-1" } },
          {
            type: "message.appended",
            data: {
              messageDelta: "Let me check that for you.",
              messageSoFar: "Let me check that for you.",
              sequence: 2,
              stepIndex: 0,
              turnId: "turn-1",
            },
          },
          {
            type: "message.completed",
            data: {
              finishReason: "tool-calls",
              message: "Let me check that for you.",
              sequence: 3,
              stepIndex: 0,
              turnId: "turn-1",
            },
          },
          {
            type: "message.completed",
            data: {
              finishReason: "stop",
              message: "The weather in San Francisco is mild and partly cloudy.",
              sequence: 4,
              stepIndex: 1,
              turnId: "turn-1",
            },
          },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]),
      ),
    };
    harness.send.mockResolvedValue(session);

    const route = harness.route("POST", "/voice/turn");
    const response = await (route as any).handler(
      new Request("http://localhost/voice/turn", {
        body: JSON.stringify({
          message: "What's the weather in San Francisco?",
          streamIndex: 0,
          voiceSessionId: "voice-session-1",
        }),
        method: "POST",
      }),
      harness.args,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.text).toBe(
      "Let me check that for you.\n\nThe weather in San Francisco is mild and partly cloudy.",
    );
  });

  it("rejects invalid turn payloads before dispatching to Ash", async () => {
    const harness = createRouteHarness({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });
    const route = harness.route("POST", "/voice/turn");

    const response = await (route as any).handler(
      new Request("http://localhost/voice/turn", {
        body: JSON.stringify({ message: "missing session" }),
        method: "POST",
      }),
      harness.args,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe("Expected non-empty string field `voiceSessionId`.");
    expect(harness.send).not.toHaveBeenCalled();
  });
});
