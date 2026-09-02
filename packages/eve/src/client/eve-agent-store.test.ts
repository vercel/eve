import { afterEach, describe, expect, it, vi } from "vitest";

import { detachEveAgentStore, EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_VERSION_HEADER,
  type UnstampedMessageStreamEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";
import type {
  MessageStreamEventForVersion,
  MessageStreamVersion,
} from "#protocol/message-version.js";

function turnEvents(): MessageStreamEvent[] {
  return stampTestEvents([
    createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
    createMessageCompletedEvent({
      finishReason: "stop",
      message: "Hi there.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createSessionWaitingEvent(),
  ] as UnstampedMessageStreamEvent[]);
}

function streamingTurnEvents(): MessageStreamEvent[] {
  return stampTestEvents([
    createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
    createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
    createMessageAppendedEvent({
      messageDelta: "Hel",
      messageOffset: 0,
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createMessageAppendedEvent({
      messageDelta: "lo",
      messageOffset: 3,
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createMessageCompletedEvent({
      finishReason: "stop",
      message: "Hello",
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createSessionWaitingEvent(),
  ] as UnstampedMessageStreamEvent[]);
}

function startedResponse(): Response {
  return new Response(JSON.stringify({ ok: true, sessionId: "session_1", status: "accepted" }), {
    headers: { "content-type": "application/json", [EVE_SESSION_ID_HEADER]: "session_1" },
    status: 202,
  });
}

function versionedStreamResponse<Version extends MessageStreamVersion>(
  version: Version,
  events: readonly MessageStreamEventForVersion<Version>[],
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
    {
      headers: { [EVE_STREAM_VERSION_HEADER]: version },
    },
  );
}

function streamResponse(events: readonly MessageStreamEvent[]): Response {
  return versionedStreamResponse(EVE_MESSAGE_STREAM_VERSION, events);
}

function disconnectingStreamResponse(events: readonly MessageStreamEvent[]): Response {
  return versionedDisconnectingStreamResponse(EVE_MESSAGE_STREAM_VERSION, events);
}

function versionedDisconnectingStreamResponse<Version extends MessageStreamVersion>(
  version: Version,
  events: readonly MessageStreamEventForVersion<Version>[],
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const event = events[index];
        if (event !== undefined) {
          index += 1;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    }),
    {
      headers: { [EVE_STREAM_VERSION_HEADER]: version },
    },
  );
}

function boundedStreamResponse(
  events: readonly MessageStreamEvent[],
  tailIndex = events.length - 1,
): Response {
  const response = streamResponse(events);
  response.headers.set("x-eve-stream-tail-index", String(tailIndex));
  return response;
}

function controlledStreamResponse() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    {
      headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
    },
  );

  return {
    close: () => controller?.close(),
    emit: (event: MessageStreamEvent) => {
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    response,
  };
}

function acceptedCancellationResponse(): Response {
  return Response.json({
    ok: true,
    sessionId: "session_1",
    status: "accepted",
  });
}

function preV20MessageCompletedEvent(): MessageStreamEvent {
  return {
    ...createMessageCompletedEvent({
      finishReason: "stop",
      message: "Legacy response.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_legacy",
    }),
    meta: { at: "2026-07-27T18:04:11.912Z" },
  } as MessageStreamEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EveAgentStore stream overlap", () => {
  it("reconstructs a split message across an in-memory stream reconnect", async () => {
    const events = streamingTurnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(disconnectingStreamResponse(events.slice(0, 3)))
      .mockResolvedValueOnce(streamResponse(events.slice(3)));
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    const streamingText: string[] = [];
    store.subscribe(() => {
      const part = store.snapshot.data.messages.at(-1)?.parts.at(-1);
      if (part?.type === "text" && part.state === "streaming") streamingText.push(part.text);
    });

    await store.send({ message: "Hello" });

    expect(streamingText).toContain("Hel");
    expect(streamingText).toContain("Hello");
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Hello",
      type: "text",
    });
    expect(
      fetchMock.mock.calls
        .slice(1)
        .map(([request]) =>
          new URL(request.toString(), "http://localhost").searchParams.get("startIndex"),
        ),
    ).toEqual([null, "3"]);
  });

  it("reconstructs a split message across a v24-to-v25 reconnect", async () => {
    const current = streamingTurnEvents();
    const received = current[0]!;
    const started = current[1]!;
    if (received.type !== "message.received" || started.type !== "turn.started") {
      throw new Error("Expected the streaming fixture to begin a turn.");
    }
    const legacyPrefix = [
      received,
      started,
      {
        data: {
          messageDelta: "Hel",
          messageSoFar: "Hel",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: current[2]!.meta,
        type: "message.appended",
      },
    ] satisfies readonly MessageStreamEventForVersion<"24">[];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(versionedDisconnectingStreamResponse("24", legacyPrefix))
      .mockResolvedValueOnce(versionedStreamResponse("25", current.slice(3)));
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    const streamingText: string[] = [];
    store.subscribe(() => {
      const part = store.snapshot.data.messages.at(-1)?.parts.at(-1);
      if (part?.type === "text" && part.state === "streaming") streamingText.push(part.text);
    });

    await store.send({ message: "Hello" });

    expect(streamingText).toContain("Hel");
    expect(streamingText).toContain("Hello");
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Hello",
      type: "text",
    });
    expect(
      fetchMock.mock.calls
        .slice(1)
        .map(([request]) =>
          new URL(request.toString(), "http://localhost").searchParams.get("startIndex"),
        ),
    ).toEqual([null, "3"]);
  });

  it("rejects a prepared turn containing both a message and input responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    store.setCallbacks({
      prepareSend: () =>
        ({
          inputResponses: [{ optionId: "approve", requestId: "request_1" }],
          message: "also send this",
        }) as never,
    });
    const invalidSend = () => {
      // @ts-expect-error message and inputResponses are mutually exclusive.
      void store.send({
        inputResponses: [{ optionId: "approve", requestId: "request_1" }],
        message: "also send this",
      });
    };
    expect(invalidSend).toBeTypeOf("function");

    await store.send({ message: "hello" });

    expect(store.snapshot.error?.message).toBe(
      "A turn requires exactly one of message or inputResponses.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("folds an initialEvents prefix that the live stream re-delivers in once", async () => {
    const events = turnEvents();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      // The server-rendered prefix is replayed ahead of the live tail.
      .mockResolvedValueOnce(streamResponse(events));

    const store = new EveAgentStore({
      initialEvents: events.slice(0, 2),
      reducer: defaultMessageReducer(),
    });

    const seen: MessageStreamEvent[] = [];
    store.setCallbacks({ onEvent: (event) => seen.push(event) });

    await store.send({ message: "Hello" });

    // Only the events the prefix did not already carry reach subscribers.
    expect(seen.map((event) => event.meta.id)).toEqual([events[2]?.meta.id]);
    expect(store.snapshot.events.map((event) => event.meta.id)).toEqual(
      events.map((event) => event.meta.id),
    );

    const assistant = store.snapshot.data.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.parts).toEqual([
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Hi there.", type: "text" },
    ]);
  });

  it("applies a pre-v20 event whose envelope has no id", async () => {
    const legacy = preV20MessageCompletedEvent();
    const boundary = stampTestEvents([createSessionWaitingEvent()])[0]!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse([legacy, boundary]));

    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    const seen: MessageStreamEvent[] = [];
    store.setCallbacks({ onEvent: (event) => seen.push(event) });

    await store.send({ message: "Hello" });

    expect(seen).toEqual([legacy, boundary]);
    expect(store.snapshot.events).toEqual([legacy, boundary]);
    const assistant = store.snapshot.data.messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Legacy response.", type: "text" },
    ]);
  });

  it("re-admits events after reset clears the window", async () => {
    const events = turnEvents();
    const store = new EveAgentStore({
      initialEvents: events,
      reducer: defaultMessageReducer(),
    });
    expect(store.snapshot.events).toHaveLength(3);

    store.reset();
    expect(store.snapshot.events).toHaveLength(0);

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse(events));

    await store.send({ message: "Hello" });

    // A fresh session must not have the retired ids held against it.
    expect(store.snapshot.events.map((event) => event.meta.id)).toEqual(
      events.map((event) => event.meta.id),
    );
  });
});

describe("EveAgentStore session resume", () => {
  it("continues a split message from a complete hydrated prefix", async () => {
    const events = streamingTurnEvents();
    const prefix = events.slice(0, 3);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse([events[3]!], 3))
      .mockResolvedValueOnce(streamResponse(events.slice(4)));
    const store = new EveAgentStore({
      initialEvents: prefix,
      initialSession: { sessionId: "session_1", streamIndex: prefix.length },
      reducer: defaultMessageReducer(),
    });
    const streamingText: string[] = [];
    store.subscribe(() => {
      const part = store.snapshot.data.messages.at(-1)?.parts.at(-1);
      if (part?.type === "text" && part.state === "streaming") streamingText.push(part.text);
    });

    await store.resume();

    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBe(String(prefix.length));
    expect(streamingText).toContain("Hello");
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Hello",
      type: "text",
    });
  });

  it("replays a split message from index zero when only its cursor was retained", async () => {
    const events = streamingTurnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events.slice(0, 4), 3))
      .mockResolvedValueOnce(streamResponse(events.slice(4)));
    const store = new EveAgentStore({
      initialSession: { sessionId: "session_1", streamIndex: 3 },
      reducer: defaultMessageReducer(),
    });
    const streamingText: string[] = [];
    store.subscribe(() => {
      const part = store.snapshot.data.messages.at(-1)?.parts.at(-1);
      if (part?.type === "text" && part.state === "streaming") streamingText.push(part.text);
    });

    await store.resume();

    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBeNull();
    expect(streamingText).toContain("Hello");
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Hello",
      type: "text",
    });
  });

  it("keeps a settled hydrated snapshot resuming until catch-up returns ready", async () => {
    const events = turnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse([], events.length - 1))
      .mockResolvedValueOnce(streamResponse([]));
    const store = new EveAgentStore({
      initialEvents: events,
      initialSession: { sessionId: "session_1", streamIndex: events.length },
      reducer: defaultMessageReducer(),
    });
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(store.snapshot.status));

    await store.resume();

    expect(statuses[0]).toBe("resuming");
    expect(statuses).not.toContain("submitted");
    expect(statuses).not.toContain("streaming");
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual(events);
    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBe(String(events.length));
  });

  it("replays from index zero when the hydrated log does not match its cursor", async () => {
    const events = turnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events))
      .mockResolvedValueOnce(streamResponse([]));
    const store = new EveAgentStore({
      initialEvents: events.slice(0, 1),
      initialSession: { sessionId: "session_1", streamIndex: 2 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBeNull();
    expect(store.snapshot.events).toEqual(events);
    expect(store.snapshot.status).toBe("ready");
  });

  it("moves an unsettled hydrated snapshot to streaming before following it", async () => {
    const [received, started, completed, waiting] = stampTestEvents([
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Hi there.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const initialEvents = [received!, started!];
    const live = controlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse([], initialEvents.length - 1))
      .mockResolvedValueOnce(live.response);
    const store = new EveAgentStore({
      initialEvents,
      initialSession: { sessionId: "session_1", streamIndex: initialEvents.length },
      reducer: defaultMessageReducer(),
    });

    const resuming = store.resume();
    expect(store.snapshot.status).toBe("resuming");
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBe(String(initialEvents.length));

    live.emit(completed!);
    live.emit(waiting!);
    live.close();
    await resuming;

    expect(store.snapshot.status).toBe("ready");
  });

  it("publishes a hydrated terminal failure with error status", async () => {
    const failed = stampTestEvents([
      createSessionFailedEvent({
        code: "SESSION_FAILED",
        message: "Session failed.",
        sessionId: "session_1",
      }),
    ])[0]!;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(boundedStreamResponse([], 0));
    const store = new EveAgentStore({
      initialEvents: [failed],
      initialSession: { sessionId: "session_1", streamIndex: 1 },
      reducer: defaultMessageReducer(),
    });
    const published: Array<{ eventType: string | undefined; status: string }> = [];
    store.subscribe(() => {
      published.push({
        eventType: store.snapshot.events.at(-1)?.type,
        status: store.snapshot.status,
      });
    });

    await store.resume();

    expect(published).toContainEqual({ eventType: "session.failed", status: "error" });
    expect(store.snapshot.error?.message).toBe("Session failed.");
  });

  it("probes beyond a settled replay without reconnecting an idle stream", async () => {
    const events = turnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events))
      .mockResolvedValueOnce(streamResponse([]));
    const store = new EveAgentStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });
    const publishedEventCounts: number[] = [];
    store.subscribe(() => publishedEventCounts.push(store.snapshot.events.length));

    await store.resume();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(fetchMock.mock.calls[1]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBe(String(events.length));
    expect(publishedEventCounts).not.toContain(1);
    expect(publishedEventCounts).not.toContain(2);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual(events);
    expect(store.snapshot.session).toEqual({ sessionId: "session_1", streamIndex: events.length });
  });

  it("follows a turn accepted after the last settled event was persisted", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Hi there.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ message: "Again", sequence: 0, turnId: "turn_2" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_2" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "A second reply.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const settled = events.slice(0, 3);
    const [received, started, completed, waiting] = events.slice(3);
    const live = controlledStreamResponse();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(settled))
      .mockResolvedValueOnce(live.response);
    const store = new EveAgentStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    const resuming = store.resume();
    await vi.waitFor(() => expect(store.snapshot.events).toEqual(settled));

    live.emit(received!);
    live.emit(started!);
    live.emit(completed!);
    live.emit(waiting!);
    live.close();
    await resuming;

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events.slice(settled.length).map((event) => event.type)).toEqual([
      "message.received",
      "turn.started",
      "message.completed",
      "session.waiting",
    ]);
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "A second reply.",
      type: "text",
    });
  });

  it("replays history and follows an interrupted turn through its boundary", async () => {
    const [received, started, completed, waiting] = stampTestEvents([
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Hi there.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const live = controlledStreamResponse();
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      requests.push(url);
      return requests.length === 1 ? boundedStreamResponse([received!, started!]) : live.response;
    });
    const store = new EveAgentStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    const resuming = store.resume();
    expect(store.resume()).toBe(resuming);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    expect(store.snapshot.events.map((event) => event.type)).toEqual([
      "message.received",
      "turn.started",
    ]);

    live.emit(completed!);
    live.emit(waiting!);
    live.close();
    await resuming;

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Hi there.",
      type: "text",
    });
    expect(new URL(requests[0]!, "http://localhost").searchParams.get("startIndex")).toBeNull();
    expect(new URL(requests[1]!, "http://localhost").searchParams.get("startIndex")).toBe("2");
  });
});

describe("EveAgentStore steering", () => {
  it("accepts an in-flight steer and follows its replacement turn", async () => {
    const activeStream = controlledStreamResponse();
    const replacementStream = controlledStreamResponse();
    const [
      firstReceived,
      firstStarted,
      firstCancelled,
      firstWaiting,
      secondReceived,
      secondStarted,
      secondCompleted,
      secondWaiting,
    ] = stampTestEvents([
      createMessageReceivedEvent({ message: "First", sequence: 0, turnId: "turn_1" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createTurnCancelledEvent({ sequence: 2, turnId: "turn_1" }),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ message: "Instead", sequence: 0, turnId: "turn_2" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_2" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Replacement reply.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(activeStream.response)
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(replacementStream.response);
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    const firstSend = store.send({ message: "First" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    activeStream.emit(firstReceived!);
    activeStream.emit(firstStarted!);

    const steering = store.send({ message: "Instead", turnPolicy: "steer" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      message: "Instead",
      turnPolicy: "steer",
    });

    activeStream.emit(firstCancelled!);
    activeStream.emit(firstWaiting!);
    activeStream.close();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    replacementStream.emit(secondReceived!);
    replacementStream.emit(secondStarted!);
    replacementStream.emit(secondCompleted!);
    replacementStream.emit(secondWaiting!);
    replacementStream.close();

    await Promise.all([firstSend, steering]);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual([
      firstReceived,
      firstStarted,
      firstCancelled,
      firstWaiting,
      secondReceived,
      secondStarted,
      secondCompleted,
      secondWaiting,
    ]);
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Replacement reply.",
      type: "text",
    });
  });
});

describe("EveAgentStore terminal failure", () => {
  it("publishes a live terminal failure with error status", async () => {
    const failed = stampTestEvents([
      createSessionFailedEvent({
        code: "SESSION_FAILED",
        message: "Session failed.",
        sessionId: "session_1",
      }),
    ])[0]!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse([failed]));
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    const published: Array<{ eventType: string | undefined; status: string }> = [];
    store.subscribe(() => {
      published.push({
        eventType: store.snapshot.events.at(-1)?.type,
        status: store.snapshot.status,
      });
    });

    await store.send({ message: "Hello" });

    expect(published.find((snapshot) => snapshot.eventType === "session.failed")?.status).toBe(
      "error",
    );
    expect(store.snapshot.error?.message).toBe("Session failed.");
  });
});

describe("EveAgentStore cancellation", () => {
  it("queues cancellation until the turn id arrives and keeps streaming", async () => {
    const stream = controlledStreamResponse();
    const [turnStarted, turnCancelled, boundary] = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createTurnCancelledEvent({ sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(acceptedCancellationResponse());
    const store = new EveAgentStore({ optimistic: false, reducer: defaultMessageReducer() });

    const sending = store.send({ message: "Hello" });
    const cancellation = store.cancel();
    const duplicateCancellation = store.cancel();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    stream.emit(turnStarted!);
    await expect(cancellation).resolves.toEqual({
      sessionId: "session_1",
      status: "accepted",
    });
    await expect(duplicateCancellation).resolves.toEqual({
      sessionId: "session_1",
      status: "accepted",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/eve/v1/session/session_1/cancel");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      turnId: "turn_1",
    });
    expect(store.snapshot.status).toBe("streaming");

    stream.emit(turnCancelled!);
    stream.emit(boundary!);
    stream.close();
    await sending;

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual([turnStarted, turnCancelled, boundary]);
  });

  it("returns no_active_turn when idle", async () => {
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await expect(store.cancel()).resolves.toEqual({ status: "no_active_turn" });
  });

  it("resolves a queued cancellation when reset wins before dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    const sending = store.send({ message: "Hello" });
    const cancellation = store.cancel();
    store.reset();

    await expect(cancellation).resolves.toEqual({ status: "no_active_turn" });
    await sending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.snapshot.status).toBe("ready");
  });

  it("detaches local transport without cancelling durable server work", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    });
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    const sending = store.send({ message: "Hello" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    detachEveAgentStore(store);
    await sending;

    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.snapshot.status).toBe("ready");
  });
});
