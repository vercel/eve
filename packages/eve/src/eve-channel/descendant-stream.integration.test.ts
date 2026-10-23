import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { InternalSession } from "#channel/session.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { eveChannel } from "#eve-channel/index.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachRemoteAgentStreamHeadersResolver } from "#internal/nitro/routes/channel-route-context.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
  EVE_DESCENDANT_STREAM_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
import { EVE_OBSERVATION_KEY_HEADER } from "#protocol/descendant-observation.js";
import { linesOf } from "#protocol/session-lines.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

const at = "2026-10-10T00:00:00.000Z";
afterEach(() => vi.restoreAllMocks());
function opened(
  parent: string,
  id: string,
  remote = false,
): Extract<SessionStreamEvent, { type: "child.opened" }> {
  return {
    type: "child.opened",
    meta: { at, position: { line: 0, index: 0 }, endOfLine: true },
    data: {
      name: id,
      sessionId: id,
      owner: { callId: `open_${id}` },
      stream: remote
        ? createEveSubagentStreamRoutePath({
            parentSessionId: parent,
            callId: `open_${id}`,
            childSessionId: id,
          })
        : createEveSessionStreamRoutePath(id),
    },
  };
}
function deployment(origin: string, token: string) {
  const histories = new Map<string, SessionEvent[]>();
  const bindings = new Map<string, RemoteChildBinding>();
  const tokens = new Map<string, string>();
  const attached: string[] = [];
  const authorization = vi.fn((binding: RemoteAgentBinding) =>
    Promise.resolve({ authorization: `Bearer ${tokens.get(binding.url)}` }),
  );
  const channel = eveChannel({
    auth: (request) =>
      request.headers.get("authorization") === `Bearer ${token}`
        ? { authenticator: "test", principalId: "alice", principalType: "user", attributes: {} }
        : null,
  });
  const serve = async (request: Request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.split("/")[4]!);
    const descendant = url.pathname.endsWith("/descendants/stream");
    const route = channel.routes!.find(
      (route) =>
        route.method === "GET" &&
        route.path ===
          (descendant ? EVE_DESCENDANT_STREAM_ROUTE_PATTERN : EVE_SESSION_STREAM_ROUTE_PATTERN),
    )!;
    const attachSession = (sessionId: string): InternalSession => {
      attached.push(sessionId);
      if (!histories.has(sessionId)) throw new Error("Unknown session");
      return {
        id: sessionId,
        getChildBinding: async (childId) => bindings.get(JSON.stringify([sessionId, childId])),
        getStreamTailIndex: async () => linesOf(histories.get(sessionId)!, at).length - 1,
        getLineStream: async (options) =>
          new ReadableStream({
            start(controller) {
              for (const line of linesOf(histories.get(sessionId)!, at).slice(
                options?.startIndex ?? 0,
              ))
                controller.enqueue(line);
              controller.close();
            },
          }),
      } as InternalSession;
    };
    const args = {
      ...mockAgentRouteArgs(),
      ...mockChannelContext(() => {
        throw new Error("Unexpected execution");
      }),
      params: { sessionId: id },
      attachSession,
      waitUntil: () => undefined,
      requestIp: "127.0.0.1",
      to: () => {
        throw new Error("Unexpected execution");
      },
    } satisfies RouteHandlerArgs;
    attachRemoteAgentStreamHeadersResolver(args, authorization);
    return (await route.handler(request, args)) as Response;
  };
  const link = (parent: string, child: string, remote?: string) => {
    const event = opened(parent, child, remote !== undefined);
    histories.set(parent, [
      ...(histories.get(parent) ?? []),
      { type: event.type, data: event.data },
    ]);
    if (remote !== undefined)
      bindings.set(JSON.stringify([parent, child]), {
        callId: `open_${child}`,
        childSessionId: child,
        name: child,
        streamPath: event.data.stream,
        url: remote,
      });
    return event;
  };
  return { origin, histories, bindings, tokens, attached, authorization, serve, link };
}
function network(...deployments: ReturnType<typeof deployment>[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const origin = new URL(request.url).origin;
    const server = deployments.find((server) => server.origin === origin);
    if (server === undefined) throw new Error("Untrusted destination");
    return server.serve(request);
  });
}

describe("authorized descendant readers", () => {
  it("composes local → remote → local → remote through authenticated parent proxies", async () => {
    const home = deployment("https://home.test", "browser");
    const desk = deployment("https://desk.test", "desk-reader");
    const reviewer = deployment("https://reviewer.test", "reviewer-reader");
    home.tokens.set(desk.origin, "desk-reader");
    desk.tokens.set(reviewer.origin, "reviewer-reader");
    const first = home.link("root", "desk", desk.origin);
    const second = desk.link("desk", "workflow-child");
    const third = desk.link("workflow-child", "reviewer", reviewer.origin);
    reviewer.histories.set("reviewer", [{ type: "session.started", data: {} }]);
    const requests = network(home, desk, reviewer);
    const session = new Client({
      baseUrl: home.origin,
      auth: { bearer: "browser" },
    }).sessions.attach("root");
    const reader = session.agent(first).agent(second).agent(third);
    const events = [];
    for await (const event of reader.stream({ follow: false })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["session.started"]);
    expect(
      requests.mock.calls.map(
        ([url]) => new URL(String(url instanceof Request ? url.url : url)).origin,
      ),
    ).toEqual([home.origin, desk.origin, reviewer.origin]);
    expect(
      requests.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer browser", "Bearer desk-reader", "Bearer reviewer-reader"]);
    expect(home.attached).toEqual(["root"]);
    expect(desk.attached).toEqual(["desk", "workflow-child"]);
    expect(home.authorization).toHaveBeenCalledTimes(1);
    expect(desk.authorization).toHaveBeenCalledTimes(1);
  });

  it("rejects forged cached links and unrelated children before contacting any foreign destination", async () => {
    const home = deployment("https://home.test", "browser");
    home.histories.set("root", []);
    const requests = network(home);
    const forged = {
      ...opened("root", "unrelated", true),
      data: { ...opened("root", "unrelated").data, stream: "https://foreign.test/collect" },
    };
    const reader = new Client({ baseUrl: home.origin, auth: { bearer: "browser" } }).sessions
      .attach("root")
      .agent(forged);
    await expect(
      collect(reader.stream({ follow: false, streamReconnectPolicy: { reconnect: false } })),
    ).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(home.attached).toEqual(["root"]);
    expect(home.authorization).not.toHaveBeenCalled();
  });

  it("verifies cached source coordinates and stops a recorded cycle without granting another read", async () => {
    const home = deployment("https://home.test", "browser");
    const child = home.link("root", "child");
    const back = home.link("child", "root");
    network(home);
    const session = new Client({
      baseUrl: home.origin,
      auth: { bearer: "browser" },
    }).sessions.attach("root");
    const wrong = { ...child, meta: { ...child.meta, position: { line: 999, index: 0 } } };
    await expect(
      collect(
        session.agent(wrong).stream({ follow: false, streamReconnectPolicy: { reconnect: false } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(home.attached).toEqual(["root"]);
    home.attached.splice(0);
    await expect(
      collect(session.agent(child).agent(back).stream({ follow: false })),
    ).rejects.toMatchObject({ status: 422, code: "cycle" });
    expect(home.attached).toEqual(["root", "child"]);
  });

  it("rechecks remote credentials and authorization on each read, without forwarding foreign redirects", async () => {
    const home = deployment("https://home.test", "browser");
    const remote = deployment("https://remote.test", "valid");
    home.tokens.set(remote.origin, "valid");
    remote.histories.set("child", [{ type: "session.started", data: {} }]);
    const child = home.link("root", "child", remote.origin);
    const requests = network(home, remote);
    const reader = new Client({ baseUrl: home.origin, auth: { bearer: "browser" } }).sessions
      .attach("root")
      .agent(child);
    expect(await collect(reader.stream({ follow: false }))).toHaveLength(1);
    home.tokens.set(remote.origin, "revoked");
    await expect(collect(reader.stream({ follow: false }))).rejects.toMatchObject({ status: 401 });
    expect(home.authorization).toHaveBeenCalledTimes(2);
    home.tokens.set(remote.origin, "valid");
    requests.mockImplementationOnce(async () =>
      home.serve(
        new Request(
          `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify([{ sessionId: "child", position: 0 }]))}&follow=false`,
          { headers: { authorization: "Bearer browser" } },
        ),
      ),
    );
    requests.mockImplementationOnce(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://foreign.test/collect" } }),
    );
    await expect(collect(reader.stream({ follow: false }))).rejects.toMatchObject({ status: 422 });
    expect(requests.mock.calls.at(-1)?.[1]?.redirect).toBe("manual");
  });

  it("rejects unauthenticated access before reading a parent and exposes scoped identities only after validation", async () => {
    const home = deployment("https://home.test", "browser");
    const event = home.link("root", "child");
    home.histories.set("child", [{ type: "session.started", data: {} }]);
    network(home);
    const bad = new Client({ baseUrl: home.origin, auth: { bearer: "wrong" } }).sessions
      .attach("root")
      .agent(event);
    await expect(collect(bad.stream({ follow: false }))).rejects.toMatchObject({ status: 401 });
    expect(home.attached).toEqual([]);
    const response = await home.serve(
      new Request(
        `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify([{ sessionId: "child", position: 0 }]))}&follow=false`,
        { headers: { authorization: "Bearer browser" } },
      ),
    );
    expect(response.headers.get(EVE_OBSERVATION_KEY_HEADER)).toBe(
      JSON.stringify(["local", "child"]),
    );
    await response.text();
  });
});
