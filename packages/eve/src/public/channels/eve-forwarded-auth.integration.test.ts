import { describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for forwarded auth across the create route and the
 * runtime: an accepted `forwardedAuth` body becomes the run's session
 * principal (`AuthKey` / `InitiatorAuthKey`, projected as
 * `session.auth.current` / `.initiator`) and reaches
 * `resolveConnectionPrincipal` as a `user` principal — the seam per-user
 * Vercel Connect requires on the receiving deployment.
 */

import type { RouteHandlerArgs, SendFn, SendOptions } from "#channel/routes.js";
import type { Session as ChannelSession } from "#channel/session.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { isConnectionAuthorizationFailedError } from "#public/connections/errors.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { eveChannel, type EveChannelInput } from "#public/channels/eve.js";

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

  const mockSend = vi.fn<SendFn>().mockResolvedValue({
    id: "receiver-session-id",
    continuationToken: "eve:test",
    async cancel() {
      return { status: "no_active_turn" };
    },
    async getEventStream() {
      return new ReadableStream();
    },
  } satisfies ChannelSession);

  return {
    send: mockSend,
    async fetch(req: Request) {
      const args: RouteHandlerArgs = {
        send: mockSend,
        resolveActiveSession: async () => undefined,
        cancel: vi.fn(),
        getSession: vi.fn(),
        receive: vi.fn() as never,
        params: {},
        waitUntil: () => undefined,
        requestIp: "127.0.0.1",
      };
      return (
        createRoute as { handler: (req: Request, args: RouteHandlerArgs) => unknown }
      ).handler(req, args) as Promise<Response>;
    },
  };
}

describe("eveChannel forwarded auth → runtime principal", () => {
  it("seeds the forwarded principal into the run context and resolves a user Connect principal", async () => {
    const handler = createEveCreateHandler({
      acceptForwardedAuth: (caller) => caller.principalId === ROUTER_CALLER.principalId,
      auth: () => ROUTER_CALLER,
    });

    const response = await handler.fetch(
      new Request("https://receiver.example.com/eve/v1/session", {
        body: JSON.stringify({
          forwardedAuth: { current: FORWARDED_CURRENT, initiator: FORWARDED_INITIATOR },
          message: "check my dashboards",
          mode: "task",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ forwardedAuth: "accepted" });

    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    const run: RunInput = {
      adapter: { kind: "eve" },
      auth: options.auth,
      channelName: "eve",
      continuationToken: "eve:test",
      initiatorAuth: options.initiatorAuth,
      input: { message: "check my dashboards" },
      mode: "task",
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
      acceptForwardedAuth: () => true,
      auth: () => ROUTER_CALLER,
    });

    await handler.fetch(
      new Request("https://receiver.example.com/eve/v1/session", {
        body: JSON.stringify({ message: "check my dashboards", mode: "task" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    const ctx = buildRunContext({
      bundle: {} as CompiledBundle,
      run: {
        adapter: { kind: "eve" },
        auth: options.auth,
        channelName: "eve",
        continuationToken: "eve:test",
        input: { message: "check my dashboards" },
        mode: "task",
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
