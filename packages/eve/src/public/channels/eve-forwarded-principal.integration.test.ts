import { describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for forwarded principal across the create route and the
 * runtime: an accepted `forwardedPrincipal` body becomes the run's session
 * principal (`AuthKey` / `InitiatorAuthKey`, projected as
 * `session.auth.current` / `.initiator`) and reaches
 * `resolveConnectionPrincipal` as a `user` principal — the seam per-user
 * Vercel Connect requires on the receiving deployment.
 */

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { isConnectionAuthorizationFailedError } from "#public/connections/errors.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { eveChannel, type EveChannelInput } from "#public/channels/eve.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";

const ROUTER_CALLER: SessionAuthContext = {
  attributes: {},
  authenticator: "oidc",
  issuer: "https://oidc.vercel.com/acme",
  principalId: "https://oidc.vercel.com/acme:owner:acme:project:router:environment:production",
  principalType: "service",
  subject: "owner:acme:project:router:environment:production",
};

const FORWARDED_CURRENT: SessionAuthContext = {
  attributes: { user_id: "U123" },
  authenticator: "slack-webhook",
  issuer: "slack",
  principalId: "slack:U123",
  principalType: "user",
  subject: "U123",
};

const FORWARDED_INITIATOR: SessionAuthContext = {
  attributes: {},
  authenticator: "slack-webhook",
  issuer: "slack",
  principalId: "slack:U999",
  principalType: "user",
  subject: "U999",
};

function createEveCreateHandler(input: EveChannelInput) {
  const channel = eveChannel(input);
  const createRoute = channel.routes.find(
    (route) => route.method === "POST" && route.path === "/eve/v1/session",
  );
  if (!createRoute) throw new Error("No create POST route found");

  const createSession = vi.fn().mockResolvedValue({
    events: new ReadableStream(),
    sessionId: "receiver-session-id",
  });

  return {
    createSession,
    async fetch(req: Request) {
      const args = attachRouteSessionCreator<RouteHandlerArgs>(
        {
          ...mockChannelContext(vi.fn()),
          attachSession: vi.fn() as any,
          to: vi.fn() as never,
          params: {},
          waitUntil: () => undefined,
          requestIp: "127.0.0.1",
        },
        createSession,
      );
      return (
        createRoute as { handler: (req: Request, args: RouteHandlerArgs) => unknown }
      ).handler(req, args) as Promise<Response>;
    },
  };
}

describe("eveChannel forwarded principal → runtime principal", () => {
  it("seeds the forwarded principal into the run context and resolves a user Connect principal", async () => {
    const handler = createEveCreateHandler({
      trustedForwarders: (caller) => caller.principalId === ROUTER_CALLER.principalId,
      auth: () => ROUTER_CALLER,
    });

    const response = await handler.fetch(
      new Request("https://receiver.example.com/eve/v1/session", {
        body: JSON.stringify({
          forwardedPrincipal: { current: FORWARDED_CURRENT, initiator: FORWARDED_INITIATOR },
          message: "check my dashboards",
          mode: "task",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    const options = handler.createSession.mock.calls[0]?.[0] as Omit<
      RunInput,
      "adapter" | "channelName" | "requestId"
    >;
    const run: RunInput = {
      adapter: { kind: "eve" },
      channelName: "eve",
      ...options,
    };
    const ctx = buildRunContext({ bundle: {} as CompiledBundle, run });

    const current = ctx.get(AuthKey);
    const initiator = ctx.get(InitiatorAuthKey);
    expect(current).toMatchObject({
      attributes: { "eve:forwarded-by": ROUTER_CALLER.principalId, user_id: "U123" },
      principalId: "slack:U123",
      principalType: "user",
    });
    expect(initiator).toMatchObject({
      attributes: { "eve:forwarded-by": ROUTER_CALLER.principalId },
      principalId: "slack:U999",
      principalType: "user",
    });

    const principal = contextStorage.run(ctx, () =>
      resolveConnectionPrincipal("datadog", {
        getToken: async () => ({ token: "t" }),
        principalType: "user",
      }),
    );

    expect(principal).toEqual({
      attributes: { "eve:forwarded-by": ROUTER_CALLER.principalId, user_id: "U123" },
      id: "slack:U123",
      issuer: "slack",
      type: "user",
    });
    // The audit attribute never enters Connect token-cache keying.
    expect(principalKey(principal)).toBe("user:slack:slack:U123");
  });

  it("resolves the transport service principal (and fails Connect) without forwarding", async () => {
    const handler = createEveCreateHandler({
      trustedForwarders: () => true,
      auth: () => ROUTER_CALLER,
    });

    await handler.fetch(
      new Request("https://receiver.example.com/eve/v1/session", {
        body: JSON.stringify({ message: "check my dashboards", mode: "task" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    const options = handler.createSession.mock.calls[0]?.[0] as Omit<
      RunInput,
      "adapter" | "channelName" | "requestId"
    >;
    const ctx = buildRunContext({
      bundle: {} as CompiledBundle,
      run: {
        adapter: { kind: "eve" },
        channelName: "eve",
        ...options,
      },
    });

    expect(ctx.get(AuthKey)).toEqual(ROUTER_CALLER);
    expect(ctx.get(InitiatorAuthKey)).toEqual(ROUTER_CALLER);
    const failure = (() => {
      try {
        contextStorage.run(ctx, () =>
          resolveConnectionPrincipal("datadog", {
            getToken: async () => ({ token: "t" }),
            principalType: "user",
          }),
        );
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(isConnectionAuthorizationFailedError(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: "principal_required" });
  });
});
