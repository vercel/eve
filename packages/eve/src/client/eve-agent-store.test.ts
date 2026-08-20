import { afterEach, describe, expect, it, vi } from "vitest";

import { detachEveAgentStore, EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
  EVE_SESSION_ID_HEADER,
  type UnstampedMessageStreamEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";

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

function startedResponse(): Response {
  return new Response(JSON.stringify({ ok: true, sessionId: "session_1", status: "accepted" }), {
    headers: { "content-type": "application/json", [EVE_SESSION_ID_HEADER]: "session_1" },
    status: 202,
  });
}

function acceptedCancellationResponse(): Response {
  return Response.json({
    ok: true,
    sessionId: "session_1",
    status: "accepted",
  });
}

function streamResponse(events: readonly MessageStreamEvent[]): Response {
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
  );
}

function controlledStreamResponse(): {
  readonly close: () => void;
  readonly emit: (event: MessageStreamEvent) => void;
  readonly response: Response;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }),
  );

  return {
    close: () => controller?.close(),
    emit: (event) => controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    response,
  };
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
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(events.length));
    detachEveAgentStore(store);

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
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(2));
    detachEveAgentStore(store);

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
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(events.length));
    detachEveAgentStore(store);

    // A fresh session must not have the retired ids held against it.
    expect(store.snapshot.events.map((event) => event.meta.id)).toEqual(
      events.map((event) => event.meta.id),
    );
  });

  it("requires an explicit policy for an overlapping message", async () => {
    const stream = controlledStreamResponse();
    const [started] = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
    ] as UnstampedMessageStreamEvent[]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(stream.response);
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    const firstSend = store.send({ message: "first" });
    expect(store.snapshot.status).toBe("submitted");
    await expect(store.send({ message: "accidental duplicate" })).rejects.toThrow(
      "requires turnPolicy",
    );

    await firstSend;
    stream.emit(started!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    detachEveAgentStore(store);
    stream.close();
  });

  it("renders queued and steering submissions until their replacement turn starts", async () => {
    const stream = controlledStreamResponse();
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "first", sequence: 1, turnId: "turn_1" }),
      createTurnCancelledEvent({ sequence: 2, turnId: "turn_1" }),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 0, turnId: "turn_2" }),
      createMessageReceivedEvent({
        message: "afterward\n\nreplace it",
        sequence: 1,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") return startedResponse();
      return stream.response;
    });
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "first" });
    await store.send({ message: "afterward", turnPolicy: "queue" });
    stream.emit(events[0]!);
    stream.emit(events[1]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    expect(store.snapshot.pendingSubmissions).toMatchObject([
      { message: "afterward", status: "queued", turnPolicy: "queue" },
    ]);

    await store.send({ message: "replace it", turnPolicy: "steer" });

    expect(store.snapshot.pendingSubmissions).toEqual([
      {
        id: expect.any(String),
        message: "afterward",
        status: "queued",
        turnPolicy: "queue",
      },
      {
        id: expect.any(String),
        message: "replace it",
        status: "steering",
        turnPolicy: "steer",
      },
    ]);
    const postBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(postBodies).toEqual([
      { message: "first" },
      { message: "afterward", turnPolicy: "queue" },
      { message: "replace it", turnPolicy: "steer" },
    ]);

    stream.emit(events[2]!);
    stream.emit(events[3]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("submitted"));
    expect(store.snapshot.pendingSubmissions).toHaveLength(2);

    stream.emit(events[4]!);
    stream.emit(events[5]!);
    await vi.waitFor(() => expect(store.snapshot.pendingSubmissions).toEqual([]));
    stream.emit(events[6]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"));

    const userMessages = store.snapshot.data.messages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]?.parts).toEqual([
      { state: "done", text: "afterward\n\nreplace it", type: "text" },
    ]);

    detachEveAgentStore(store);
    stream.close();
  });

  it("keeps queued submissions that were not coalesced into the next turn", async () => {
    const stream = controlledStreamResponse();
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "first", sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 0, turnId: "turn_2" }),
      createMessageReceivedEvent({
        message: "queued 1\n\nqueued 2",
        sequence: 1,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 0, turnId: "turn_3" }),
      createMessageReceivedEvent({
        message: "queued 3\n\nqueued 4\n\nqueued 5",
        sequence: 1,
        turnId: "turn_3",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") return startedResponse();
      return stream.response;
    });
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "first" });
    stream.emit(events[0]!);
    stream.emit(events[1]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));

    for (let index = 1; index <= 5; index += 1) {
      await store.send({ message: `queued ${index}`, turnPolicy: "queue" });
    }
    expect(store.snapshot.pendingSubmissions).toHaveLength(5);

    stream.emit(events[2]!);
    stream.emit(events[3]!);
    stream.emit(events[4]!);
    await vi.waitFor(() =>
      expect(store.snapshot.pendingSubmissions.map((submission) => submission.message)).toEqual([
        "queued 3",
        "queued 4",
        "queued 5",
      ]),
    );

    stream.emit(events[5]!);
    stream.emit(events[6]!);
    stream.emit(events[7]!);
    await vi.waitFor(() => expect(store.snapshot.pendingSubmissions).toEqual([]));
    stream.emit(events[8]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"));

    detachEveAgentStore(store);
    stream.close();
  });

  it("keeps an overlapping delivery failure local to its pending submission", async () => {
    const stream = controlledStreamResponse();
    const [started] = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
    ] as UnstampedMessageStreamEvent[]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(stream.response)
      .mockRejectedValueOnce(new Error("Queue delivery failed"));
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "first" });
    stream.emit(started!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    await store.send({ message: "afterward", turnPolicy: "queue" });

    expect(store.snapshot.status).toBe("streaming");
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.pendingSubmissions).toMatchObject([
      {
        error: { message: "Queue delivery failed" },
        message: "afterward",
        status: "failed",
        turnPolicy: "queue",
      },
    ]);

    detachEveAgentStore(store);
    stream.close();
  });

  it("fails accepted pending submissions when the session terminates", async () => {
    const stream = controlledStreamResponse();
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "first", sequence: 1, turnId: "turn_1" }),
      createSessionFailedEvent({
        code: "MODEL_CALL_FAILED",
        message: "Turn failed",
        sessionId: "session_1",
      }),
    ] as UnstampedMessageStreamEvent[]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) =>
      (init?.method ?? "GET") === "POST" ? startedResponse() : stream.response,
    );
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "first" });
    stream.emit(events[0]!);
    stream.emit(events[1]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    await store.send({ message: "afterward", turnPolicy: "queue" });
    stream.emit(events[2]!);

    await vi.waitFor(() => expect(store.snapshot.status).toBe("error"));
    expect(store.snapshot.pendingSubmissions).toMatchObject([
      {
        error: { message: "Turn failed" },
        message: "afterward",
        status: "failed",
        turnPolicy: "queue",
      },
    ]);

    detachEveAgentStore(store);
    stream.close();
  });
});

describe("EveAgentStore cancellation", () => {
  it("queues cancellation until the shared follower observes the turn id", async () => {
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
    expect(store.cancel()).toBe(cancellation);

    await sending;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    stream.emit(turnStarted!);
    await expect(cancellation).resolves.toEqual({
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
    await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"));
    await expect(store.cancel()).resolves.toEqual({ status: "no_active_turn" });
    expect(store.snapshot.events).toEqual([turnStarted, turnCancelled, boundary]);

    detachEveAgentStore(store);
    stream.close();
  });

  it("targets the replacement turn after cancellation leaves queued work", async () => {
    const stream = controlledStreamResponse();
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createTurnCancelledEvent({ sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 0, turnId: "turn_2" }),
    ] as UnstampedMessageStreamEvent[]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      if (String(request).endsWith("/cancel")) return acceptedCancellationResponse();
      if ((init?.method ?? "GET") === "POST") return startedResponse();
      return stream.response;
    });
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "first" });
    stream.emit(events[0]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));
    await store.send({ message: "next", turnPolicy: "queue" });

    stream.emit(events[1]!);
    stream.emit(events[2]!);
    await vi.waitFor(() => expect(store.snapshot.status).toBe("submitted"));
    const replacementCancellation = store.cancel();
    stream.emit(events[3]!);
    await expect(replacementCancellation).resolves.toMatchObject({ status: "accepted" });

    const cancelBodies = fetchMock.mock.calls
      .filter(([request]) => String(request).endsWith("/cancel"))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(cancelBodies).toEqual([{ turnId: "turn_2" }]);

    detachEveAgentStore(store);
    stream.close();
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

  it("detaches the shared follower without cancelling durable work", async () => {
    let streamSignal: AbortSignal | undefined;
    const stream = controlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockImplementationOnce((_request, init) => {
        streamSignal = init?.signal ?? undefined;
        return Promise.resolve(stream.response);
      });
    const store = new EveAgentStore({ reducer: defaultMessageReducer() });

    await store.send({ message: "Hello" });
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    detachEveAgentStore(store);

    expect(streamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
