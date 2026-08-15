import { afterEach, describe, expect, it, vi } from "vitest";

import { detachEveAgentStore, EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
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

function controlledStreamResponse() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
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
