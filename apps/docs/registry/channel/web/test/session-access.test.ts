import assert from "node:assert/strict";
import { test } from "node:test";
import { eveChannel } from "eve/channels/eve";
import type { Channel, RouteHandlerArgs } from "eve/channels";
import { withSessionAccess } from "../lib/session-access.ts";
import type { SessionRecord, SessionStore } from "../lib/session-store.ts";

const args = (params: Record<string, string> = {}) => ({ params }) as RouteHandlerArgs;
const request = (method: string, body?: object) =>
  new Request("https://app.example/eve/v1/session", {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

test("every session route rejects foreign and unindexed sessions before reaching eve", async () => {
  let calls = 0;
  const base = eveChannel({ auth: [] });
  const protectedChannel: Channel = withSessionAccess(
    {
      ...base,
      routes: base.routes
        .filter((route) => route.transport !== "websocket")
        .map((route) => ({
          ...route,
          handler: async () => {
            calls++;
            return Response.json({ ok: true });
          },
        })),
    },
    {
      viewer: async () => ({ key: "alice", name: "Alice" }),
      store: () => ({ owns: async (_owner, id) => id === "owned" }) as SessionStore,
    },
  );
  for (const route of protectedChannel.routes.filter(
    (r) => r.path.includes(":sessionId") || r.path.includes(":parentSessionId"),
  )) {
    if (route.transport === "websocket") continue;
    for (const id of ["foreign", "missing"]) {
      const res = await route.handler(
        request(route.method),
        args({ sessionId: id, parentSessionId: id }),
      );
      assert.equal(res.status, 404, route.path);
    }
    assert.equal(
      (
        await route.handler(
          request(route.method),
          args({ sessionId: "owned", parentSessionId: "owned" }),
        )
      ).status,
      200,
      route.path,
    );
  }
  assert.equal(calls, 7);
});

test("creation commits ownership before exposing its ID and preserves eve retry keys", async () => {
  let currentOwner = "alice";
  const records: SessionRecord[] = [];
  const operations: string[] = [];
  let fail = false;
  const base = eveChannel({ auth: [] });
  const channel = withSessionAccess(
    {
      ...base,
      routes: [
        {
          method: "POST" as const,
          path: "/eve/v1/session",
          handler: async (req: Request) => {
            operations.push((await req.json()).operationId);
            return Response.json({ sessionId: "wrun_A" }, { status: 202 });
          },
        },
      ],
    },
    {
      viewer: async () => ({ key: currentOwner, name: currentOwner }),
      store: () =>
        ({
          record: async (record: SessionRecord) => {
            if (fail) throw new Error();
            records.push(record);
          },
        }) as SessionStore,
    },
  );
  const route = (channel as Channel).routes[0];
  if (route.transport === "websocket") throw new Error();
  assert.equal(
    (await route.handler(request("POST", { operationId: "retry" }), args())).status,
    202,
  );
  assert.equal(records[0].ownerKey, "alice");
  await route.handler(request("POST", { operationId: "retry" }), args());
  currentOwner = "bob";
  await route.handler(request("POST", { operationId: "retry" }), args());
  assert.equal(operations[0], operations[1]);
  assert.equal(operations[0], "retry");
  assert.equal(operations[0], operations[2]);
  fail = true;
  assert.equal((await route.handler(request("POST", {}), args())).status, 503);
});

test("invalid identities fail closed and cross-origin writes never reach eve", async () => {
  let called = false;
  const base = eveChannel({ auth: [] });
  const channel: Channel = {
    ...base,
    routes: [
      {
        method: "POST" as const,
        path: "/eve/v1/session",
        handler: async () => {
          called = true;
          return Response.json({});
        },
      },
    ],
  };
  const invalid = withSessionAccess(channel, {
    viewer: async () => {
      throw new Error();
    },
    store: () => {
      throw new Error();
    },
  });
  if (invalid.routes[0].transport === "websocket") throw new Error();
  assert.equal((await invalid.routes[0].handler(request("POST"), args())).status, 401);
  const cross = withSessionAccess(channel, {
    viewer: async () => ({ key: "a", name: "A" }),
    store: () => ({}) as SessionStore,
  });
  const req = new Request("https://app.example/eve/v1/session", {
    method: "POST",
    headers: { Origin: "https://other.example" },
  });
  if (cross.routes[0].transport === "websocket") throw new Error();
  assert.equal((await cross.routes[0].handler(req, args())).status, 403);
  assert.equal(called, false);
});

test("anonymous requests still go through eve authentication", async () => {
  const channel = withSessionAccess(eveChannel({ auth: [] }), {
    viewer: async () => null,
    store: () => {
      throw new Error("Anonymous requests must not reach storage.");
    },
  });
  const route = channel.routes.find((route) => route.path === "/eve/v1/session/:sessionId/stream")!;
  if (route.transport === "websocket") throw new Error();
  const response = await route.handler(request("GET"), args({ sessionId: "wrun_A" }));
  assert.equal(response.status, 401);
});

test("configured public origin permits browser mutations through an internal service URL", async () => {
  const previous = process.env.WEB_CHAT_ORIGIN;
  process.env.WEB_CHAT_ORIGIN = "https://app.example";
  try {
    const base = eveChannel({ auth: [] });
    const channel = withSessionAccess(
      {
        ...base,
        routes: [
          {
            method: "POST",
            path: "/eve/v1/session/:sessionId",
            handler: async () => Response.json({ ok: true }),
          },
        ],
      },
      {
        viewer: async () => ({ key: "alice", name: "Alice" }),
        store: () => ({
          owns: async () => true,
          ownsChild: async () => false,
          recordChild: async () => {},
          record: async () => {},
          update: async () => {},
          list: async () => ({ sessions: [] }),
        }),
      },
    );
    const route = (channel as Channel).routes[0];
    if (route.transport === "websocket") throw new Error("Expected HTTP");
    const req = new Request("http://0.0.0.0:3000/eve/v1/session/owned", {
      method: "POST",
      headers: {
        Origin: "https://app.example",
        "x-forwarded-host": "app.example",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal((await route.handler(req, args({ sessionId: "owned" }))).status, 200);
    const forged = new Request(req, {
      headers: { Origin: "https://evil.example", "x-forwarded-host": "evil.example" },
    });
    assert.equal((await route.handler(forged, args({ sessionId: "owned" }))).status, 403);
  } finally {
    if (previous === undefined) delete process.env.WEB_CHAT_ORIGIN;
    else process.env.WEB_CHAT_ORIGIN = previous;
  }
});
