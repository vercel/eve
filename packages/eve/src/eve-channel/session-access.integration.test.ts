import { H3, getRouterParams } from "nitro/h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "#channel/session.js";
import type { Delivery } from "#shared/delivery.js";
import type { SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import { buildSessionCreatorAttributes } from "#execution/session-creator.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const storage = vi.hoisted(() => ({
  attributes: new Map<string, Record<string, string>>(),
  reads: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", async (original) => ({
  ...(await original<typeof import("#internal/workflow/runtime.js")>()),
  getWorld: async () => ({
    runs: {
      get: async (id: string) => {
        storage.reads(id);
        return { attributes: storage.attributes.get(id) ?? {}, status: "running" };
      },
    },
  }),
}));

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test-issuer",
  principalId: "alice",
  principalType: "user",
  subject: "alice",
};
const bob = { ...alice, principalId: "bob", subject: "bob" };
const sessionId = "alice-session";
const unexpected = () => {
  throw new Error("Unexpected session operation");
};
const receipt: Delivery = {
  sessionId,
  deliveryId: "delivery",
  stream: unexpected,
  result: unexpected,
};

beforeEach(() => {
  storage.attributes.clear();
  storage.reads.mockClear();
});

function recordCreator(id: string, creator: SessionAuthContext | null) {
  storage.attributes.set(id, buildSessionCreatorAttributes(creator));
}

function serve(config: EveChannelConfig) {
  const send = vi.fn(async () => receipt);
  const cancel = vi.fn(async () => receipt);
  const attach = vi.fn((id: string): Session => ({
    id,
    send,
    cancel,
    respond: unexpected,
    prewarm: unexpected,
    clear: unexpected,
    compact: unexpected,
    end: unexpected,
    stream: unexpected,
  }));
  const create = vi.fn(async () => ({ sessionId }));
  const channel = eveChannel(config);
  const app = new H3();
  for (const route of channel.routes) {
    if (route.transport === "websocket") throw new Error("eve channel routes are HTTP only");
    app.on(route.method, route.path, (event) =>
      route.handler(
        event.req,
        attachRouteSessionCreator(
          {
            ...mockAgentRouteArgs(),
            ...mockChannelContext(() => {
              throw new Error("Unexpected channel delivery");
            }),
            to: () => {
              throw new Error("Unexpected cross-channel delivery");
            },
            params: getRouterParams(event),
            attachSession: attach,
            waitUntil: () => undefined,
            requestIp: "127.0.0.1",
          },
          create as never,
        ),
      ),
    );
  }
  return { app, attach, cancel, channel, create, send };
}

function request(path: string, method = "POST", body: unknown = {}) {
  const init: RequestInit = { method };
  if (method !== "GET") init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

const sessionRoutes = eveChannel({ auth: () => alice }).routes.filter(
  (route) => route.path.includes(":sessionId") || route.path.includes(":parentSessionId"),
);

describe("session route authorization", () => {
  it.each(sessionRoutes)("gates $method $path before session access", async (route) => {
    const authorizeSession = vi.fn(() => false);
    const server = serve({ auth: () => ({ ...bob, allowToolStubs: true }), authorizeSession });
    const path = route.path
      .replace(":sessionId", sessionId)
      .replace(":parentSessionId", sessionId)
      .replace(":callId", "call")
      .replace(":childSessionId", "child");
    const response = await server.app.request(request(path, route.method));
    expect(response.status).toBe(403);
    expect(authorizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ caller: bob, sessionId }),
    );
    expect(server.attach).not.toHaveBeenCalled();
    expect(storage.reads).not.toHaveBeenCalled();
  });

  it("passes the router-matched session ID to the policy", async () => {
    const authorizeSession = vi.fn(() => false);
    const server = serve({ auth: () => bob, authorizeSession });
    const response = await server.app.request(request("/eve/v1/session/alice%2Dsession/cancel"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "Session access denied." });
    expect(authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(server.attach).not.toHaveBeenCalled();
  });

  it("lets the recorded creator send the first message without turn records", async () => {
    recordCreator(sessionId, alice);
    let caller: SessionAuthContext = bob;
    const server = serve({
      auth: () => caller,
      authorizeSession: async ({ caller: current, getCreator }) => {
        const creator = await getCreator();
        return creator?.issuer === current.issuer && creator?.principalId === current.principalId;
      },
    });
    const path = `/eve/v1/session/${sessionId}`;
    expect((await server.app.request(request(path, "POST", { message: "Hello" }))).status).toBe(
      403,
    );
    expect(server.send).not.toHaveBeenCalled();
    caller = alice;
    expect((await server.app.request(request(path, "POST", { message: "Hello" }))).status).toBe(
      202,
    );
    expect(server.send).toHaveBeenCalledOnce();
  });

  it("distinguishes missing and anonymous creators and records identity only", async () => {
    const observed: unknown[] = [];
    const server = serve({
      auth: () => alice,
      authorizeSession: async ({ getCreator }) => {
        observed.push(await getCreator());
        return false;
      },
    });
    const path = `/eve/v1/session/${sessionId}/cancel`;
    await server.app.request(request(path));
    recordCreator(sessionId, null);
    await server.app.request(request(path));
    recordCreator(sessionId, { ...alice, principalType: "anonymous" });
    await server.app.request(request(path));
    const withGrant = { ...alice, allowToolStubs: true, attributes: { email: "a@b" } };
    recordCreator(sessionId, withGrant);
    await server.app.request(request(path));
    expect(observed).toEqual([undefined, null, null, alice]);
  });

  it("preserves access without a hook and permits policies that need no creator lookup", async () => {
    for (const authorizeSession of [undefined, () => true]) {
      const server = serve({ auth: () => alice, authorizeSession });
      const response = await server.app.request(request(`/eve/v1/session/${sessionId}/cancel`));
      expect(response.status).toBe(202);
      expect(server.cancel).toHaveBeenCalledOnce();
    }
    expect(storage.reads).not.toHaveBeenCalled();
  });

  it("does not run the policy before authentication", async () => {
    const authorizeSession = vi.fn(() => true);
    const server = serve({ auth: () => null, authorizeSession });
    expect((await server.app.request(request(`/eve/v1/session/${sessionId}/cancel`))).status).toBe(
      401,
    );
    expect(authorizeSession).not.toHaveBeenCalled();
  });

  it("fails closed without exposing policy errors", async () => {
    captureLogRecords();
    const server = serve({
      auth: () => alice,
      authorizeSession: () => {
        throw new Error("private policy details");
      },
    });
    const response = await server.app.request(request(`/eve/v1/session/${sessionId}/cancel`));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: "Session access denied.",
      errorId: expect.any(String),
    });
    expect(body).not.toContain("private policy details");
    expect(server.attach).not.toHaveBeenCalled();
  });

  it("records the transport identity as creator under an accepted forwarded principal", async () => {
    const forwarder = { ...bob, principalType: "service" };
    const payload = { forwardedPrincipal: { current: bob, initiator: alice } };
    const untrusted = serve({ auth: () => forwarder, authorizeSession: () => true });
    expect((await untrusted.app.request(request("/eve/v1/session", "POST", payload))).status).toBe(
      403,
    );
    expect(untrusted.create).not.toHaveBeenCalled();
    const trusted = serve({
      auth: () => forwarder,
      authorizeSession: () => true,
      trustedForwarders: () => true,
    });
    expect((await trusted.app.request(request("/eve/v1/session", "POST", payload))).status).toBe(
      202,
    );
    expect(trusted.create).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ principalId: bob.principalId }),
        sessionCreator: forwarder,
      }),
    );
  });

  it("records the transport identity regardless of the onMessage projection", async () => {
    const authorizeSession = vi.fn(() => false);
    const server = serve({ auth: () => alice, authorizeSession, onMessage: () => ({ auth: bob }) });
    expect((await server.app.request(request("/eve/v1/session"))).status).toBe(202);
    expect(server.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: alice, sessionCreator: alice }),
    );
    expect(
      (await server.app.request(request("/eve/v1/session", "POST", { message: "Hello" }))).status,
    ).toBe(202);
    expect(server.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: bob, sessionCreator: alice }),
    );
    expect(authorizeSession).not.toHaveBeenCalled();
  });
});
