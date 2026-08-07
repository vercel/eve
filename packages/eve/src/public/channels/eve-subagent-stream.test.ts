import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import {
  attachRemoteAgentStreamHeadersResolver,
  type RemoteAgentStreamHeadersResolver,
} from "#internal/nitro/routes/channel-route-context.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { createSubagentCalledEvent, type MessageStreamEvent } from "#protocol/message.js";
import { EVE_SUBAGENT_STREAM_ROUTE_PATTERN } from "#protocol/routes.js";
import { none, type AuthFn } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";

const coordinates = {
  callId: "call-1",
  childSessionId: "child-1",
  parentSessionId: "parent-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eveChannel remote subagent stream", () => {
  it("authenticates before reading the parent or fetching upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createHarness({ auth: () => null, events: [remoteCalledEvent()] });

    const response = await harness.fetch(proxyRequest());

    expect(response.status).toBe(401);
    expect(harness.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a forged tuple and a local child without fetching upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const forged = createHarness({
      events: [remoteCalledEvent({ callId: "different-call" })],
    });
    const local = createHarness({ events: [localCalledEvent()] });

    expect((await forged.fetch(proxyRequest())).status).toBe(404);
    expect((await local.fetch(proxyRequest())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 without fetching when the authored remote resolver no longer matches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createHarness({
      events: [remoteCalledEvent()],
      resolveHeaders: vi.fn().mockRejectedValue(new Error("remote URL mismatch")),
    });

    const response = await harness.fetch(proxyRequest());

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies an exact remote binding incrementally with authored credentials and cursors", async () => {
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-eve-stream-format": "ndjson",
          "x-eve-stream-tail-index": "8",
          "x-eve-stream-version": "21",
        },
        status: 206,
        statusText: "Partial Content",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolveHeaders = vi.fn<RemoteAgentStreamHeadersResolver>().mockResolvedValue({
      authorization: "Bearer authored",
      "x-authored": "yes",
    });
    const bindingCancelled = vi.fn();
    const harness = createHarness({
      bindingCancelled,
      events: [remoteCalledEvent()],
      resolveHeaders,
    });
    const abort = new AbortController();

    const response = await harness.fetch(
      proxyRequest({
        headers: { authorization: "Bearer inbound", cookie: "parent=session" },
        search: "?startIndex=-3&includeTailIndex=true",
        signal: abort.signal,
      }),
    );

    expect(bindingCancelled).toHaveBeenCalledOnce();
    expect(resolveHeaders).toHaveBeenCalledWith({
      name: "research",
      resolverId: "subagents/research",
      url: "https://remote.example/base",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://remote.example/base/eve/v1/session/child-1/stream?startIndex=-3&includeTailIndex=1",
    );
    expect(init.headers).toEqual({
      authorization: "Bearer authored",
      "x-authored": "yes",
    });
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect((init.signal as AbortSignal).aborted).toBe(false);
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("x-eve-stream-format")).toBe("ndjson");
    expect(response.headers.get("x-eve-stream-tail-index")).toBe("8");

    const reader = response.body!.getReader();
    upstreamController.enqueue(new TextEncoder().encode('{"first":true}\n'));
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    upstreamController.enqueue(new TextEncoder().encode('{"second":true}\n'));
    upstreamController.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('{"second":true}\n');

    abort.abort();
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it("passes through upstream HTTP error status, headers, and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("remote denied", {
          headers: { "x-eve-stream-version": "21" },
          status: 403,
        }),
      ),
    );
    const harness = createHarness({ events: [remoteCalledEvent()] });

    const response = await harness.fetch(proxyRequest());

    expect(response.status).toBe(403);
    expect(response.headers.get("x-eve-stream-version")).toBe("21");
    await expect(response.text()).resolves.toBe("remote denied");
  });
});

function remoteCalledEvent(overrides: Partial<typeof coordinates> = {}): MessageStreamEvent {
  const values = { ...coordinates, ...overrides };
  return stampTestEvent(
    createSubagentCalledEvent({
      callId: values.callId,
      childSessionId: values.childSessionId,
      name: "research",
      remote: {
        resolverId: "subagents/research",
        url: "https://remote.example/base",
      },
      sequence: 1,
      sessionId: values.parentSessionId,
      toolName: "research",
      turnId: "turn-1",
      workflowId: "workflow-1",
    }),
    0,
  );
}

function localCalledEvent(): MessageStreamEvent {
  return stampTestEvent(
    createSubagentCalledEvent({
      callId: coordinates.callId,
      childSessionId: coordinates.childSessionId,
      name: "research",
      sequence: 1,
      sessionId: coordinates.parentSessionId,
      toolName: "research",
      turnId: "turn-1",
      workflowId: "workflow-1",
    }),
    0,
  );
}

function createHarness(input: {
  readonly auth?: AuthFn<Request>;
  readonly bindingCancelled?: () => void;
  readonly events: readonly MessageStreamEvent[];
  readonly resolveHeaders?: RemoteAgentStreamHeadersResolver;
}) {
  const channel = eveChannel({ auth: input.auth ?? none() });
  const route = channel.routes.find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
  );
  if (route === undefined) throw new Error("No remote subagent stream route found.");

  const session: Session = {
    id: coordinates.parentSessionId,
    continuationToken: "",
    async cancel() {
      return { status: "no_active_turn" };
    },
    async getEventStream() {
      return new ReadableStream<MessageStreamEvent>({
        start(controller) {
          for (const event of input.events) controller.enqueue(event);
        },
        cancel() {
          input.bindingCancelled?.();
        },
      });
    },
    async getStreamTailIndex() {
      return input.events.length - 1;
    },
  };
  const getSession = vi.fn().mockReturnValue(session);

  return {
    getSession,
    async fetch(request: Request) {
      const args = attachRemoteAgentStreamHeadersResolver(
        createRouteArgs(getSession),
        input.resolveHeaders ?? (async () => ({})),
      );
      return await (
        route as { handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }
      ).handler(request, args);
    },
  };
}

function createRouteArgs(getSession: RouteHandlerArgs["getSession"]): RouteHandlerArgs {
  return {
    cancel: vi.fn(),
    clear: vi.fn(),
    compact: vi.fn(),
    getSession,
    params: coordinates,
    receive: vi.fn() as never,
    reset: vi.fn(),
    resolveActiveSession: async () => undefined,
    send: vi.fn(),
    waitUntil: () => undefined,
    requestIp: "127.0.0.1",
  };
}

function proxyRequest(
  input: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly search?: string;
    readonly signal?: AbortSignal;
  } = {},
): Request {
  return new Request(
    `https://parent.example/eve/v1/session/parent-1/subagents/call-1/child-1/stream${input.search ?? ""}`,
    { headers: input.headers, signal: input.signal },
  );
}
