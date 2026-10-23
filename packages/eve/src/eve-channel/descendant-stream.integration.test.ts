import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import { StreamExpiredError } from "#compiled/@workflow/errors/index.js";
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
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
import { EVE_MESSAGE_STREAM_CONTENT_TYPE } from "#protocol/session-http.js";
import { EVE_OBSERVATION_KEY_HEADER } from "#protocol/descendant-observation.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import { convertLegacyEvents } from "#execution/v26-history.js";
import { KITCHEN_SINK } from "#execution/v26-history.fixtures.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

const at = "2026-10-10T00:00:00.000Z";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
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
  const legacy = new Map<string, readonly unknown[]>();
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
    const subagent = url.pathname.includes("/subagents/");
    const route = channel.routes!.find(
      (route) =>
        route.method === "GET" &&
        route.path ===
          (descendant
            ? EVE_DESCENDANT_STREAM_ROUTE_PATTERN
            : subagent
              ? EVE_SUBAGENT_STREAM_ROUTE_PATTERN
              : EVE_SESSION_STREAM_ROUTE_PATTERN),
    )!;
    const attachSession = (sessionId: string): InternalSession => {
      attached.push(sessionId);
      if (!histories.has(sessionId) && !legacy.has(sessionId)) throw new Error("Unknown session");
      const stored = () => legacy.get(sessionId) ?? linesOf(histories.get(sessionId)!, at);
      return {
        id: sessionId,
        getChildBinding: async (childId) => bindings.get(JSON.stringify([sessionId, childId])),
        getStreamTailIndex: async () => stored().length - 1,
        getLineStream: async (options) =>
          new ReadableStream({
            start(controller) {
              for (const line of stored().slice(options?.startIndex ?? 0)) controller.enqueue(line);
              controller.close();
            },
          }),
        async *stream(options): AsyncIterable<SessionStreamEvent> {
          const records = legacy.get(sessionId);
          const events =
            records === undefined
              ? linesOf(histories.get(sessionId)!, at).flatMap((line, position) =>
                  eventsOfLine(line, position, at),
                )
              : convertLegacyEvents(records);
          yield* events.filter((event) => event.meta.position.line >= (options?.startIndex ?? 0));
        },
      } as InternalSession;
    };
    const args = {
      ...mockAgentRouteArgs(),
      ...mockChannelContext(() => {
        throw new Error("Unexpected execution");
      }),
      params: {
        sessionId: id,
        parentSessionId: id,
        callId: decodeURIComponent(url.pathname.split("/")[6] ?? ""),
        childSessionId: decodeURIComponent(url.pathname.split("/")[7] ?? ""),
      },
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
  return { origin, histories, legacy, bindings, tokens, attached, authorization, serve, link };
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
    const response = await requests.mock.results[0]!.value;
    expect(response.headers.get("content-type")).toBe(EVE_MESSAGE_STREAM_CONTENT_TYPE);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    {
      name: "nested HTML success",
      nested: true,
      contentType: "text/html",
      status: 200,
      expectedStatus: 502,
      forwarded: false,
    },
    {
      name: "terminal HTML success",
      nested: false,
      contentType: "text/html",
      status: 200,
      expectedStatus: 502,
      forwarded: false,
    },
    {
      name: "missing content type",
      nested: true,
      contentType: undefined,
      status: 200,
      expectedStatus: 502,
      forwarded: false,
    },
    {
      name: "HTML authorization error",
      nested: true,
      contentType: "text/html",
      status: 401,
      expectedStatus: 401,
      forwarded: false,
    },
    {
      name: "JSON expiry error",
      nested: true,
      contentType: "Application/JSON; charset=utf-8",
      status: 410,
      expectedStatus: 410,
      forwarded: true,
    },
  ])(
    "enforces safe upstream response types: $name",
    async ({ nested, contentType, status, expectedStatus, forwarded }) => {
      const home = deployment("https://home.test", "browser");
      home.link("root", "desk", "https://remote.test");
      home.tokens.set("https://remote.test", "remote-reader");
      const cancel = vi.fn();
      const headers = new Headers({
        [EVE_OBSERVATION_KEY_HEADER]: JSON.stringify(["local", "nested"]),
      });
      if (contentType !== undefined) headers.set("content-type", contentType);
      const body = JSON.stringify({
        code: "session_expired",
        error: "Remote maintenance response.",
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
            cancel,
          }),
          { status, headers },
        ),
      );
      const children = [
        { sessionId: "desk", position: 0 },
        ...(nested ? [{ sessionId: "nested", position: 0 }] : []),
      ];
      const response = await home.serve(
        new Request(
          `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify(children))}`,
          { headers: { authorization: "Bearer browser" } },
        ),
      );
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (forwarded) {
        expect(await response.text()).toBe(body);
        expect(cancel).not.toHaveBeenCalled();
      } else {
        expect(await response.text()).not.toContain("Remote maintenance response.");
        expect(cancel).toHaveBeenCalledOnce();
      }
    },
  );

  it("sanitizes upstream errors on the recorded direct subagent stream route too", async () => {
    const home = deployment("https://home.test", "browser");
    const child = home.link("root", "desk", "https://remote.test");
    home.tokens.set("https://remote.test", "remote-reader");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Remote maintenance response.", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );
    const response = await home.serve(
      new Request(new URL(child.data.stream, home.origin), {
        headers: { authorization: "Bearer browser" },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).not.toContain("Remote maintenance response.");
  });

  it("reads a child opening translated from v26 history through its recorded source position", async () => {
    const home = deployment("https://home.test", "browser");
    home.legacy.set("root", KITCHEN_SINK);
    network(home);
    const session = new Client({
      baseUrl: home.origin,
      auth: { bearer: "browser" },
    }).sessions.attach("root");
    const history = await collect(session.stream({ follow: false }));
    const child = history.find((event) => event.type === "child.opened")!;
    home.histories.set(child.data.sessionId, [{ type: "session.started", data: {} }]);
    const events = await collect(
      session.agent(child).stream({ follow: false, streamReconnectPolicy: { reconnect: false } }),
    );
    expect(events.map((event) => event.type)).toEqual(["session.started"]);
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
    home.histories
      .get("root")!
      .unshift({ type: "call.progress", data: { callId: "another", output: "Working." } });
    for (const line of [0, 999]) {
      const wrong = { ...child, meta: { ...child.meta, position: { line, index: 0 } } };
      await expect(
        collect(
          session
            .agent(wrong)
            .stream({ follow: false, streamReconnectPolicy: { reconnect: false } }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(home.attached).toEqual(["root"]);
      home.attached.splice(0);
    }
    const recorded = { ...child, meta: { ...child.meta, position: { line: 1, index: 0 } } };
    await expect(
      collect(session.agent(recorded).agent(back).stream({ follow: false })),
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

  it("reports an expired ancestor without disguising it as a startup race", async () => {
    const home = deployment("https://home.test", "browser");
    home.link("root", "child");
    vi.spyOn(home.histories, "get").mockImplementation(() => {
      throw new StreamExpiredError("History expired.", "root");
    });
    const response = await home.serve(
      new Request(
        `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify([{ sessionId: "child", position: 0 }]))}&follow=false`,
        { headers: { authorization: "Bearer browser" } },
      ),
    );
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "session_expired" });
    expect(home.attached).toEqual(["root"]);
  });

  it("normalizes validated coordinates before forwarding the remaining remote path", async () => {
    const home = deployment("https://home.test", "browser");
    const remote = deployment("https://remote.test", "remote-reader");
    home.link("root", "desk", remote.origin);
    remote.link("desk", "nested");
    remote.histories.set("nested", [{ type: "session.started", data: {} }]);
    home.tokens.set(remote.origin, "remote-reader");
    const requests = network(home, remote);
    const children = [
      { sessionId: "desk", position: 0, ignored: "first" },
      { sessionId: "nested", position: 0, ignored: "second" },
    ];
    const response = await home.serve(
      new Request(
        `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify(children))}&follow=false`,
        { headers: { authorization: "Bearer browser" } },
      ),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(
      JSON.parse(new URL(String(requests.mock.calls[0]![0])).searchParams.get("children")!),
    ).toEqual([{ sessionId: "nested", position: 0 }]);
  });

  it("limits resolution without cutting off an authorized live remote body at ten seconds", async () => {
    vi.useFakeTimers();
    const home = deployment("https://home.test", "browser");
    home.link("root", "child", "https://remote.test");
    home.tokens.set("https://remote.test", "remote-reader");
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream(), {
        headers: { "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE },
      });
    });
    const controller = new AbortController();
    const response = await home.serve(
      new Request(
        `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify([{ sessionId: "child", position: 0 }]))}`,
        { headers: { authorization: "Bearer browser" }, signal: controller.signal },
      ),
    );
    try {
      expect(response.status).toBe(200);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
    } finally {
      await response.body?.cancel();
    }
  });

  it.each(["abort", "deadline"])(
    "bounds a stalled credential resolver on %s without a late upstream request",
    async (mode) => {
      vi.useFakeTimers();
      const home = deployment("https://home.test", "browser");
      home.link("root", "child", "https://remote.test");
      const credentials = Promise.withResolvers<{ authorization: string }>();
      home.authorization.mockImplementation(() => credentials.promise);
      const requests = network(home);
      const controller = new AbortController();
      const response = home.serve(
        new Request(
          `https://home.test/eve/v1/session/root/descendants/stream?children=${encodeURIComponent(JSON.stringify([{ sessionId: "child", position: 0 }]))}&follow=false`,
          {
            headers: { authorization: "Bearer browser" },
            signal: controller.signal,
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(home.authorization).toHaveBeenCalledTimes(1);
      if (mode === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      expect((await response).status).toBe(404);
      credentials.resolve({ authorization: "Bearer later" });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).not.toHaveBeenCalled();
    },
  );

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
