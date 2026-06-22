import { describe, expect, it, vi } from "vitest";

import { isHttpRouteDefinition } from "#channel/routes.js";
import type { Channel } from "#public/definitions/defineChannel.js";
import { none } from "#public/channels/auth.js";
import { realtimeSpeechChannel } from "#public/channels/vercel/speech.js";

async function callRoute(
  channel: Channel,
  method: string,
  path: string,
  request: Request,
): Promise<Response> {
  const route = channel.routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error(`Missing HTTP route ${method} ${path}`);
  }
  return route.handler(request, {
    getSession: vi.fn() as any,
    params: {},
    receive: vi.fn() as any,
    requestIp: null,
    send: vi.fn() as any,
    waitUntil: vi.fn(),
  });
}

describe("realtimeSpeechChannel", () => {
  it("mints a Gateway realtime token and returns the voice session id", async () => {
    const getToken = vi.fn(async () => ({
      expiresAt: 1_700_000_060,
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
    }));
    const channel = realtimeSpeechChannel({
      auth: none(),
      basePath: "/voice",
      createVoiceSessionId: () => "voice-session-1",
      expiresAfterSeconds: 120,
      getToken,
    });

    const response = await callRoute(
      channel,
      "POST",
      "/voice/setup",
      new Request("http://localhost/voice/setup"),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getToken).toHaveBeenCalledWith({
      expiresAfterSeconds: 120,
      model: "openai/gpt-realtime-2",
    });
    expect(body).toMatchObject({
      expiresAt: 1_700_000_060,
      tools: [],
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
      voiceSessionId: "voice-session-1",
    });
  });

  it("reuses a client-supplied voice session id", async () => {
    const channel = realtimeSpeechChannel({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });

    const response = await callRoute(
      channel,
      "POST",
      "/voice/setup",
      new Request("http://localhost/voice/setup?voiceSessionId=existing-session"),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.voiceSessionId).toBe("existing-session");
  });

  it("exposes only setup and health routes (no blocking /turn route)", () => {
    const channel = realtimeSpeechChannel({
      auth: none(),
      basePath: "/voice",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });

    expect(channel.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /voice/health",
      "POST /voice/setup",
    ]);
    expect(channel.routes.some((route) => route.path.endsWith("/turn"))).toBe(false);
  });

  it("serves a health route", async () => {
    const channel = realtimeSpeechChannel({
      auth: none(),
      basePath: "/voice",
      model: "openai/gpt-realtime-2",
      getToken: async () => ({ token: "vcst_unused", url: "wss://gateway.example" }),
    });

    const response = await callRoute(
      channel,
      "GET",
      "/voice/health",
      new Request("http://localhost/voice/health"),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toEqual({ ok: true, channel: "realtime-speech", model: "openai/gpt-realtime-2" });
  });
});
