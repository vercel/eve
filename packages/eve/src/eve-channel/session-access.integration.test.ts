import { H3, getRouterParams } from "nitro/h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "#channel/session.js";
import type { Delivery } from "#shared/delivery.js";
import type { SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import { recordSessionCreator } from "#execution/session-creator.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const storage = vi.hoisted(() => ({ records: new Map<string, unknown[]>(), reads: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", async (original) => ({
  ...(await original<typeof import("#internal/workflow/runtime.js")>()),
  getRun: (id: string) => ({
    getWritable: ({ namespace }: { namespace: string }) =>
      new WritableStream({
        write(value) {
          const key = `${id}/${namespace}`;
          storage.records.set(key, [...(storage.records.get(key) ?? []), structuredClone(value)]);
        },
      }),
    getReadable: ({ namespace }: { namespace: string }) => {
      storage.reads(id);
      const records = storage.records.get(`${id}/${namespace}`) ?? [];
      return Object.assign(
        new ReadableStream({
          start(controller) {
            for (const record of records) controller.enqueue(record);
            controller.close();
          },
        }),
        { getTailIndex: async () => records.length - 1 },
      );
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
  storage.records.clear();
  storage.reads.mockClear();
});

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
    if (route.transport === "websocket") continue;
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
    expect(authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(server.attach).not.toHaveBeenCalled();
  });

  it("lets the recorded creator send the first message without turn records", async () => {
    await recordSessionCreator(sessionId, alice);
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

  it("distinguishes missing and anonymous creators without persisting permission grants", async () => {
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
    await recordSessionCreator(sessionId, null);
    await server.app.request(request(path));
    storage.records.clear();
    const withGrant = { ...alice, allowToolStubs: true };
    await recordSessionCreator(sessionId, withGrant);
    await server.app.request(request(path));
    expect(observed).toEqual([undefined, null, alice]);
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
    expect(await response.json()).toEqual({ ok: false, error: "Session access denied." });
    expect(server.attach).not.toHaveBeenCalled();
  });

  it("records an accepted forwarded creator and rejects untrusted assertions", async () => {
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
        sessionCreator: { ...alice, attributes: { "eve:forwarded-by": forwarder.principalId } },
      }),
    );
  });

  it("records the effective creation identity without authorizing a nonexistent session", async () => {
    const authorizeSession = vi.fn(() => false);
    const server = serve({ auth: () => alice, authorizeSession, onMessage: () => ({ auth: bob }) });
    expect((await server.app.request(request("/eve/v1/session"))).status).toBe(202);
    expect(server.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionCreator: alice }),
    );
    expect(
      (await server.app.request(request("/eve/v1/session", "POST", { message: "Hello" }))).status,
    ).toBe(202);
    expect(server.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionCreator: bob }),
    );
    expect(authorizeSession).not.toHaveBeenCalled();
  });
});
