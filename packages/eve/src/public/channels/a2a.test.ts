import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { httpBasic, none } from "#public/channels/auth.js";
import { A2A_AGENT_CARD_PATH, a2aChannel } from "#public/channels/a2a.js";
import { mergeUploadPolicy } from "#public/channels/upload-policy.js";

describe("a2aChannel", () => {
  it("fails closed when auth is omitted, and rejects invalid config", () => {
    expect(() => a2aChannel({} as never)).toThrow("a2aChannel requires auth");
    expect(() => a2aChannel({ auth: none(), route: "eve/a2a" })).toThrow("absolute path");
    expect(() => a2aChannel({ auth: none(), route: A2A_AGENT_CARD_PATH })).toThrow("absolute path");
    expect(() => a2aChannel({ auth: none(), maxBlockingMs: 0 })).toThrow("maxBlockingMs");
    for (const [publicOrigin, message] of [
      ["agent.example.com", "absolute URL"],
      ["ftp://agent.example.com", "http(s)"],
      ["https://agent.example.com/api/a2a", "no path"],
      ["https://agent.example.com/?x=1", "no path"],
      ["https://user:pw@agent.example.com", "credentials"],
    ]) {
      expect(() => a2aChannel({ auth: none(), publicOrigin })).toThrow(message);
    }
  });

  it("hands its upload policy to the runtime, which enforces it on downloaded files", () => {
    const channel = a2aChannel({
      auth: none(),
      uploadPolicy: { allowedMediaTypes: ["image/*"], maxBytes: 1024 },
    });
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
    expect(channel.adapter.uploadPolicy).toEqual(
      mergeUploadPolicy({ allowedMediaTypes: ["image/*"], maxBytes: 1024 }),
    );
  });

  it("serves the Agent Card publicly and the JSON-RPC endpoint at its route", () => {
    const channel = a2aChannel({ auth: none(), route: "/a2a" });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${A2A_AGENT_CARD_PATH}`,
      `OPTIONS ${A2A_AGENT_CARD_PATH}`,
      "POST /a2a",
    ]);
  });

  it("advertises the configured origin, auth, and upload policy on the card", async () => {
    const channel = a2aChannel({
      auth: httpBasic({ password: "secret-password", username: "alice" }),
      uploadPolicy: "disabled",
      publicOrigin: "https://agents.example.com/",
    });
    const response = await handler(channel, "GET")(
      new Request(`http://127.0.0.1${A2A_AGENT_CARD_PATH}`, { headers: { host: "127.0.0.1" } }),
      routeArgs(),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({
      defaultInputModes: ["text/plain", "application/json"],
      name: "compiled-agent",
      securitySchemes: { basic: { httpAuthSecurityScheme: { scheme: "Basic" } } },
      supportedInterfaces: [{ url: "https://agents.example.com/eve/v1/a2a" }],
    });
  });

  it("challenges an unauthenticated JSON-RPC call before reading it", async () => {
    const channel = a2aChannel({
      auth: httpBasic({ password: "secret-password", username: "alice" }),
    });
    const response = await handler(channel, "POST")(
      new Request("http://127.0.0.1/eve/v1/a2a", {
        body: "{}",
        headers: { "a2a-version": "1.0", host: "127.0.0.1" },
        method: "POST",
      }),
      routeArgs(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("refuses plain HTTP off loopback and cross-origin browser calls", async () => {
    const rpc = handler(a2aChannel({ auth: none() }), "POST");
    const remote = await rpc(
      new Request("http://agent.example.com/eve/v1/a2a", {
        body: "{}",
        headers: { host: "agent.example.com" },
        method: "POST",
      }),
      routeArgs(),
    );
    expect(remote.status).toBe(403);
    expect(await remote.text()).toContain("A2A endpoints require HTTPS");
    const crossOrigin = await rpc(
      new Request("http://127.0.0.1/eve/v1/a2a", {
        body: "{}",
        headers: { host: "127.0.0.1", origin: "https://evil.example.com" },
        method: "POST",
      }),
      routeArgs(),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("takes plain HTTP as plainHttp says, and advertises the URL the client used", async () => {
    const plain = (headers: Record<string, string> = {}) =>
      new Request("http://agent.internal:3000/eve/v1/a2a", {
        body: "{}",
        headers: { "a2a-version": "1.0", host: "agent.internal:3000", ...headers },
        method: "POST",
      });
    const forwarded = a2aChannel({ auth: none(), plainHttp: "forwarded-https" });
    expect((await handler(forwarded, "POST")(plain(), routeArgs())).status).toBe(403);
    // Past the guard, an empty body is the JSON-RPC layer's to refuse.
    const proxied = await handler(forwarded, "POST")(
      plain({ "x-forwarded-proto": "https" }),
      routeArgs(),
    );
    expect(proxied.status).not.toBe(403);
    const allowed = a2aChannel({ auth: none(), plainHttp: "allow" });
    expect((await handler(allowed, "POST")(plain(), routeArgs())).status).not.toBe(403);

    const card = await handler(forwarded, "GET")(
      new Request(`http://agent.internal:3000${A2A_AGENT_CARD_PATH}`, {
        headers: { host: "agent.internal:3000", "x-forwarded-proto": "https" },
      }),
      routeArgs(),
    );
    expect(await card.json()).toMatchObject({
      supportedInterfaces: [{ url: "https://agent.internal/eve/v1/a2a" }],
    });
  });
});

function handler(channel: ReturnType<typeof a2aChannel>, method: string) {
  const route = channel.routes.find((candidate) => candidate.method === method);
  if (route === undefined || route.transport === "websocket") throw new Error("expected route");
  return route.handler;
}

function routeArgs(): RouteHandlerArgs {
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const args: RouteHandlerArgs = {
    ...mockAgentRouteArgs(),
    attachSession: unavailable,
    describe: async () => ({ name: "compiled-agent", skills: [], tools: [] }),
    from: unavailable,
    params: {},
    requestIp: "127.0.0.1",
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  return attachRouteSessionCreator(args, vi.fn());
}
