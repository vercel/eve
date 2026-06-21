import { describe, expect, it, vi } from "vitest";

import { isHttpRouteDefinition, isWebSocketRouteDefinition } from "#channel/routes.js";
import type { Channel } from "#public/definitions/defineChannel.js";
import { none } from "#public/channels/auth.js";
import { createControlToken, verifyControlToken } from "#public/channels/vercel/control-token.js";
import { vercelSpeechChannel } from "#public/channels/vercel/speech.js";

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

describe("vercelSpeechChannel", () => {
  it("mints a Gateway realtime token and returns the voice session id", async () => {
    const getToken = vi.fn(async () => ({
      expiresAt: 1_700_000_060,
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
    }));
    const channel = vercelSpeechChannel({
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
    const channel = vercelSpeechChannel({
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
    const channel = vercelSpeechChannel({
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
    const channel = vercelSpeechChannel({
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

    expect(body).toEqual({
      ok: true,
      channel: "realtime-speech",
      control: false,
      model: "openai/gpt-realtime-2",
    });
  });

  it("mints control config and serves the control route in gateway-control mode", async () => {
    process.env.EVE_REALTIME_CONTROL_SECRET = "ws-test-secret";
    const bypass = process.env.VERCEL_DPBP;
    const bypass2 = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.VERCEL_DPBP;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    try {
      const captured: Array<Record<string, any>> = [];
      const getToken = vi.fn(async (options: Record<string, any>) => {
        captured.push(options);
        return { token: "vcst_x", url: "wss://gateway.example" };
      });
      const channel = vercelSpeechChannel({
        auth: () => ({
          attributes: {},
          authenticator: "test",
          principalId: "u1",
          principalType: "user",
        }),
        basePath: "/voice",
        control: { controlUrl: "wss://eve.example/voice/ws" },
        getToken,
      });

      await callRoute(channel, "POST", "/voice/setup", new Request("http://localhost/voice/setup"));

      const control = captured[0]!.control as { mode: string; token: string; url: string };
      expect(control.mode).toBe("eve");
      expect(control.url).toBe("wss://eve.example/voice/ws");
      const verified = await verifyControlToken(control.token, { secret: "ws-test-secret" });
      expect(verified).toMatchObject({ ok: true, voiceSessionId: expect.any(String) });

      expect(
        channel.routes.some((route) => route.method === "WEBSOCKET" && route.path === "/voice/ws"),
      ).toBe(true);
    } finally {
      delete process.env.EVE_REALTIME_CONTROL_SECRET;
      if (bypass !== undefined) process.env.VERCEL_DPBP = bypass;
      if (bypass2 !== undefined) process.env.VERCEL_AUTOMATION_BYPASS_SECRET = bypass2;
    }
  });

  it("rejects an unauthenticated control upgrade and accepts a valid token", async () => {
    process.env.EVE_REALTIME_CONTROL_SECRET = "ws-test-secret";
    try {
      const channel = vercelSpeechChannel({
        auth: none(),
        basePath: "/voice",
        control: true,
        getToken: async () => ({ token: "vcst_x", url: "wss://gateway.example" }),
      });
      const route = channel.routes.find(
        (candidate) => candidate.method === "WEBSOCKET" && candidate.path === "/voice/ws",
      );
      if (route === undefined || !isWebSocketRouteDefinition(route)) {
        throw new Error("Missing control WS route");
      }
      const hooks = await route.handler(new Request("http://localhost/voice/ws"), {
        getSession: vi.fn() as any,
        params: {},
        receive: vi.fn() as any,
        requestIp: null,
        send: vi.fn() as any,
        waitUntil: vi.fn(),
      });

      const rejected = await hooks.upgrade!(new Request("http://localhost/voice/ws"));
      expect(rejected).toBeInstanceOf(Response);
      expect((rejected as Response).status).toBe(401);

      const token = await createControlToken({
        auth: { attributes: {}, authenticator: "t", principalId: "u", principalType: "user" },
        voiceSessionId: "v1",
        ttlSeconds: 60,
        secret: "ws-test-secret",
      });
      const accepted = await hooks.upgrade!(
        new Request("http://localhost/voice/ws", { headers: { authorization: `Bearer ${token}` } }),
      );
      expect(accepted).not.toBeInstanceOf(Response);
    } finally {
      delete process.env.EVE_REALTIME_CONTROL_SECRET;
    }
  });
});
