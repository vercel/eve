import { describe, expect, it, vi } from "vitest";

import type { MessageStreamEvent } from "../src/protocol/message.js";
import { stampTestEvents } from "../src/internal/testing/events.js";
import { mockChannelContext } from "../src/internal/testing/mocks/mock-channel-operations.js";
import type { AttachSessionFn, RouteHandlerArgs } from "../src/channel/routes.js";
import type { Session } from "../src/channel/session.js";
import { EVE_SESSION_STREAM_ROUTE_PATTERN } from "../src/protocol/routes.js";
import { none } from "../src/public/channels/auth.js";
import { eveChannel } from "../src/public/channels/eve.js";

/**
 * Regression coverage for the bug introduced when the stream route
 * stopped forwarding the `startIndex` query parameter to
 * `agent.getEventStream`.
 *
 * Without the fix, every reconnect or follow-up turn replays the run
 * from index 0 — the dev REPL would render the first turn's events on
 * every subsequent message because `Session.#createEventStream` cuts off
 * at the first `session.waiting` boundary it sees.
 */

function createGetHandler() {
  const channel = eveChannel({ auth: none() });
  const getRoute = channel.routes.find(
    (r) => r.method === "GET" && r.path === EVE_SESSION_STREAM_ROUTE_PATTERN,
  );
  if (!getRoute) throw new Error("No stream GET route found");
  return getRoute;
}

describe("eveChannel GET stream", () => {
  it("forwards the startIndex query parameter into attachSession/getEventStream", async () => {
    const getRoute = createGetHandler();
    const events = createEvents(
      stampTestEvents([
        {
          type: "message.completed",
          data: {
            finishReason: "stop",
            message: "second turn reply",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
      ]),
    );
    const attachSession = createMockAttachSession(events);

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session/session_xyz/stream?startIndex=42", {
        method: "GET",
      }),
      createArgs({ attachSession, params: { sessionId: "session_xyz" } }),
    );

    expect(response.status).toBe(200);
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(attachSession.mock.calls[0]?.[0]).toBe("session_xyz");
  });

  it("passes startIndex undefined when the query parameter is absent", async () => {
    const getRoute = createGetHandler();
    const attachSession = createMockAttachSession(createEvents([]));

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session/session_xyz/stream", {
        method: "GET",
      }),
      createArgs({ attachSession, params: { sessionId: "session_xyz" } }),
    );

    expect(response.status).toBe(200);
    expect(attachSession).toHaveBeenCalledTimes(1);
  });

  it("accepts negative tail-relative startIndex values", async () => {
    const getRoute = createGetHandler();
    const attachSession = createMockAttachSession(createEvents([]));

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session/session_xyz/stream?startIndex=-3", {
        method: "GET",
      }),
      createArgs({ attachSession, params: { sessionId: "session_xyz" } }),
    );

    expect(response.status).toBe(200);
    expect(attachSession).toHaveBeenCalledTimes(1);
  });

  it("rejects non-integer startIndex values with 400", async () => {
    const getRoute = createGetHandler();
    const attachSession = createMockAttachSession(createEvents([]));

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session/session_xyz/stream?startIndex=banana", {
        method: "GET",
      }),
      createArgs({ attachSession, params: { sessionId: "session_xyz" } }),
    );

    expect(response.status).toBe(400);
    expect(attachSession).toHaveBeenCalledWith("session_xyz");
  });

  it("returns 400 when the sessionId path parameter is missing", async () => {
    const getRoute = createGetHandler();
    const attachSession = createMockAttachSession(createEvents([]));

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session//stream", { method: "GET" }),
      createArgs({ attachSession, params: {} }),
    );

    expect(response.status).toBe(400);
    expect(attachSession).not.toHaveBeenCalled();
  });

  it("re-serializes the parsed event stream as NDJSON bytes", async () => {
    const getRoute = createGetHandler();
    const events = stampTestEvents([
      {
        type: "message.completed",
        data: {
          finishReason: "stop",
          message: "hello",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message" },
      },
    ]);
    const attachSession = createMockAttachSession(createEvents(events));

    const response = await (getRoute as any).handler(
      new Request("https://example.com/eve/v1/session/session_xyz/stream", {
        method: "GET",
      }),
      createArgs({ attachSession, params: { sessionId: "session_xyz" } }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const [firstLine, secondLine] = lines;
    expect(firstLine).toBeDefined();
    expect(secondLine).toBeDefined();
    expect(JSON.parse(firstLine ?? "")).toMatchObject({ type: "message.completed" });
    expect(JSON.parse(secondLine ?? "")).toMatchObject({ type: "session.waiting" });
  });
});

function createEvents(events: readonly MessageStreamEvent[]): ReadableStream<MessageStreamEvent> {
  return new ReadableStream<MessageStreamEvent>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

function createMockAttachSession(events: ReadableStream<MessageStreamEvent>) {
  return vi.fn<AttachSessionFn>().mockReturnValue({
    id: "session_xyz",
    async send() {
      return { sessionId: "session_xyz", status: "accepted" };
    },
    async respond() {
      return { sessionId: "session_xyz", status: "accepted" };
    },
    async cancel() {
      return { status: "no_active_turn" };
    },
    async compact() {
      return { sessionId: "session_xyz", status: "accepted" };
    },
    async clear() {
      return { sessionId: "session_xyz", status: "accepted" };
    },
    async reset() {
      return { previousSessionId: "session_xyz", status: "reset" };
    },
    async getEventStream() {
      return events;
    },
    async getStreamTailIndex() {
      return -1;
    },
  } satisfies Session);
}

function createArgs(input: {
  readonly attachSession: AttachSessionFn;
  readonly params: Readonly<Record<string, string>>;
}): RouteHandlerArgs {
  return {
    ...mockChannelContext(vi.fn()),
    attachSession: input.attachSession,
    to: vi.fn() as any,
    params: input.params,
    waitUntil: () => undefined,
    requestIp: "127.0.0.1",
  };
}
