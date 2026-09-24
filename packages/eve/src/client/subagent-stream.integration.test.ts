import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { Client } from "#client/client.js";
import { attachRemoteAgentStreamHeadersResolver } from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_CONTROL_VERSION,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
  createTaskStartedEvent,
  type MessageStreamEvent,
  type TaskStartedStreamEvent,
} from "#protocol/message.js";
import { EVE_SUBAGENT_STREAM_ROUTE_PATTERN } from "#protocol/routes.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";

const PARENT_ORIGIN = "https://parent.test";
const REMOTE_URL = "https://remote.test/base";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClientSession.streamSubagent through the parent proxy", () => {
  it("reads a remote child's events through the parent channel with authored remote credentials", async () => {
    const called = createCalled();
    const childEvents = [
      { type: "turn.started", data: { turnId: "child-turn" } },
      {
        type: "message.completed",
        data: { message: "Found three matches.", turnId: "child-turn" },
      },
      { type: "turn.completed", data: { turnId: "child-turn" } },
    ];
    const remoteRequests: { readonly url: string; readonly headers: Headers }[] = [];
    const parentRoute = createParentRoute(stampTestEvent(called, 0));

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === PARENT_ORIGIN) {
        return await parentRoute(new Request(url, init));
      }
      remoteRequests.push({ headers: new Headers(init?.headers), url: url.toString() });
      return ndjsonResponse(childEvents);
    });

    const session = new Client({ host: PARENT_ORIGIN }).sessions.attach("parent-1");
    const received: MessageStreamEvent[] = [];
    for await (const event of session.streamSubagent(called, { follow: false })) {
      received.push(event);
    }

    expect(received.map((event) => event.type)).toEqual([
      "turn.started",
      "message.completed",
      "turn.completed",
    ]);
    expect(remoteRequests).toHaveLength(1);
    const remoteUrl = new URL(remoteRequests[0]!.url);
    expect(`${remoteUrl.origin}${remoteUrl.pathname}`).toBe(
      `${REMOTE_URL}/eve/v1/session/child-1/stream`,
    );
    expect(remoteUrl.searchParams.get("includeTailIndex")).toBe("1");
    expect(remoteUrl.searchParams.get(EVE_STREAM_CONTROL_VERSION_QUERY)).toBe(
      EVE_STREAM_CONTROL_VERSION,
    );
    expect(remoteUrl.searchParams.has("startIndex")).toBe(false);
    expect(remoteRequests[0]!.headers.get("authorization")).toBe("Bearer authored-remote");
    expect(session.state).toEqual({ sessionId: "parent-1", streamIndex: 0 });
  });

  it("surfaces the parent's refusal when the child is not bound to that parent", async () => {
    const called = createCalled();
    const parentRoute = createParentRoute(stampTestEvent(createCalled({ callId: "other" }), 0));
    const remoteFetch = vi.fn();

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === PARENT_ORIGIN) {
        return await parentRoute(new Request(url, init));
      }
      return remoteFetch();
    });

    const session = new Client({ host: PARENT_ORIGIN }).sessions.attach("parent-1");
    const read = async () => {
      for await (const _event of session.streamSubagent(called, {
        streamReconnectPolicy: { reconnect: false },
      })) {
        // The proxy refuses before any child event exists.
      }
    };

    await expect(read()).rejects.toMatchObject({ status: 404 });
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});

function createCalled(overrides: { readonly callId?: string } = {}): TaskStartedStreamEvent {
  return createTaskStartedEvent({
    callId: overrides.callId ?? "call-1",
    child: {
      remote: { resolverId: "subagents/research", url: REMOTE_URL },
      sessionId: "child-1",
    },
    kind: "agent",
    mode: "foreground",
    name: "research",
    parentSessionId: "parent-1",
    taskId: "research-abc234",
    turnId: "turn-1",
  });
}

/** The parent deployment's real eve channel route over one recorded parent event. */
function createParentRoute(
  parentEvent: MessageStreamEvent,
): (request: Request) => Promise<Response> {
  const channel = eveChannel({ auth: none() });
  const route = channel.routes.find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
  ) as { handler: (request: Request, args: RouteHandlerArgs) => Promise<Response> } | undefined;
  if (route === undefined) throw new Error("No remote subagent stream route found.");

  const parent: Session = {
    id: "parent-1",
    send: vi.fn(),
    respond: vi.fn(),
    async cancel() {
      return { status: "no_active_turn" };
    },
    async compact() {
      return { sessionId: "parent-1", status: "accepted" };
    },
    async clear() {
      return { sessionId: "parent-1", status: "accepted" };
    },
    async reset() {
      return { previousSessionId: "parent-1", status: "reset" };
    },
    async getEventStream() {
      return new ReadableStream<MessageStreamEvent>({
        start(controller) {
          controller.enqueue(parentEvent);
          controller.close();
        },
      });
    },
    async getStreamTailIndex() {
      return 0;
    },
  };

  return async (request) => {
    const segments = new URL(request.url).pathname.split("/");
    const args = attachRemoteAgentStreamHeadersResolver(
      {
        ...mockChannelContext(vi.fn()),
        attachSession: vi.fn().mockReturnValue(parent),
        params: {
          callId: decodeURIComponent(segments[6]!),
          childSessionId: decodeURIComponent(segments[7]!),
          parentSessionId: decodeURIComponent(segments[4]!),
        },
        requestIp: "127.0.0.1",
        to: vi.fn() as never,
        waitUntil: () => undefined,
      },
      async () => ({ authorization: "Bearer authored-remote" }),
    );
    return await route.handler(request, args);
  };
}

function ndjsonResponse(events: readonly object[]): Response {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      [EVE_STREAM_TAIL_INDEX_HEADER]: String(events.length - 1),
      [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
    },
  });
}
