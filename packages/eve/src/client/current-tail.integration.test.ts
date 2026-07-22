import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session as ChannelSession } from "#channel/session.js";
import type { GetEventStreamOptions } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { Client } from "#client/client.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import {
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTurnStartedEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

function createEventStream(events: readonly HandleMessageStreamEvent[]) {
  return new ReadableStream<HandleMessageStreamEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

function createActiveEventStream(
  capturedEvents: readonly HandleMessageStreamEvent[],
  settlingEvents: readonly HandleMessageStreamEvent[],
) {
  return new ReadableStream<HandleMessageStreamEvent>({
    start(controller) {
      for (const event of capturedEvents) controller.enqueue(event);
      queueMicrotask(() => {
        for (const event of settlingEvents) controller.enqueue(event);
        controller.close();
      });
    },
  });
}

function createHarness(
  getEventStream: (
    options?: GetEventStreamOptions,
  ) => Promise<ReadableStream<HandleMessageStreamEvent>>,
) {
  const channel = eveChannel({ auth: none() });
  const streamRoute = channel.routes.find(
    (route) => route.method === "GET" && route.path === "/eve/v1/session/:sessionId/stream",
  );
  if (!streamRoute) throw new Error("No session stream GET route found");

  const session: ChannelSession = {
    async cancel() {
      return { status: "no_active_turn" };
    },
    continuationToken: "authoring-session",
    getEventStream,
    id: "session-race",
  };
  const getSession = vi.fn(() => session);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = new Request(url, {
      headers: init?.headers,
      method: init?.method,
      signal: init?.signal,
    });
    const args: RouteHandlerArgs = {
      cancel: vi.fn(),
      getSession,
      params: { sessionId: "session-race" },
      receive: vi.fn() as any,
      requestIp: "127.0.0.1",
      send: vi.fn(),
      waitUntil: () => undefined,
    };
    return (streamRoute as any).handler(request, args);
  });

  return {
    client: new Client({ host: "https://eve.test" }),
    fetchMock,
  };
}

async function collectEvents(
  events: AsyncIterable<HandleMessageStreamEvent>,
): Promise<HandleMessageStreamEvent[]> {
  const collected: HandleMessageStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientSession current-tail replay through the eve channel", () => {
  it("binds a concurrent writer and multi-turn history to one absolute snapshot request", async () => {
    const repeatedBoundary = createSessionWaitingEvent("eve:authoring-session");
    const journal: HandleMessageStreamEvent[] = [repeatedBoundary];
    const resumedTurn: HandleMessageStreamEvent[] = [
      createTurnStartedEvent({ sequence: 2, turnId: "turn-2" }),
      createMessageReceivedEvent({
        message: "accepted before replay",
        sequence: 2,
        turnId: "turn-2",
      }),
      { data: { sequence: 2, turnId: "turn-2" }, type: "turn.completed" },
      repeatedBoundary,
    ];
    const getEventStream = vi.fn(async (options?: GetEventStreamOptions) => {
      journal.push(...resumedTurn);
      return createEventStream(journal.slice(options?.startIndex ?? 0));
    });
    const { client, fetchMock } = createHarness(getEventStream);
    const session = client.session({ sessionId: "session-race", streamIndex: 0 });

    const events = await collectEvents(session.stream({ throughCurrentTail: true }));

    expect(events).toEqual([repeatedBoundary, ...resumedTurn]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getEventStream).toHaveBeenCalledOnce();
    expect(getEventStream).toHaveBeenCalledWith({
      startIndex: 0,
      throughCurrentTail: true,
    });
    expect(session.state).toEqual({
      continuationToken: "authoring-session",
      sessionId: "session-race",
      streamIndex: 5,
    });
  });

  it("waits past an active captured tail for its current-turn boundary", async () => {
    const historicalBoundary = createSessionWaitingEvent("eve:previous");
    const activeEvents: HandleMessageStreamEvent[] = [
      historicalBoundary,
      createTurnStartedEvent({ sequence: 2, turnId: "turn-2" }),
      createMessageReceivedEvent({ message: "in progress", sequence: 2, turnId: "turn-2" }),
    ];
    const currentBoundary = createSessionWaitingEvent("eve:current");
    const getEventStream = vi.fn(async () =>
      createActiveEventStream(activeEvents, [
        { data: { sequence: 2, turnId: "turn-2" }, type: "turn.completed" },
        currentBoundary,
      ]),
    );
    const { client, fetchMock } = createHarness(getEventStream);
    const session = client.session({ sessionId: "session-race", streamIndex: 0 });

    const events = await collectEvents(session.stream({ throughCurrentTail: true }));

    expect(events).toEqual([
      ...activeEvents,
      { data: { sequence: 2, turnId: "turn-2" }, type: "turn.completed" },
      currentBoundary,
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(session.state).toEqual({
      continuationToken: "current",
      sessionId: "session-race",
      streamIndex: 5,
    });
  });

  it("completes an empty snapshot without opening a durable follow", async () => {
    const getEventStream = vi.fn(async () => createEventStream([]));
    const { client, fetchMock } = createHarness(getEventStream);
    const initialState = {
      continuationToken: "current",
      sessionId: "session-race",
      streamIndex: 5,
    };
    const session = client.session(initialState);

    await expect(collectEvents(session.stream({ throughCurrentTail: true }))).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getEventStream).toHaveBeenCalledWith({ startIndex: 5, throughCurrentTail: true });
    expect(session.state).toEqual(initialState);
  });
});
