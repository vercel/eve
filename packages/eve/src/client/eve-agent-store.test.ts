import { afterEach, describe, expect, it, vi } from "vitest";

import { detachEveAgentStore, EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
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
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createMessageAppendedEvent({
      messageDelta: "lo",
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

function startedResponse(deliveryId = "delivery_1"): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      sessionId: "session_1",
      status: "accepted",
      deliveryId,
    }),
    {
      headers: { "content-type": "application/json", [EVE_SESSION_ID_HEADER]: "session_1" },
      status: 202,
    },
  );
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

const cleanupStores: Array<() => void> = [];
function createStore<TData>(
  init: ConstructorParameters<typeof EveAgentStore<TData>>[0],
): EveAgentStore<TData> {
  const store = new EveAgentStore<TData>(init);
  cleanupStores.push(() => detachEveAgentStore(store));
  return store;
}

afterEach(() => {
  for (const cleanup of cleanupStores.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EveAgentStore prewarming", () => {
  it("settles a send aborted during preparation without creating a session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const store = createStore({ reducer: defaultMessageReducer() });
    const preparation = Promise.withResolvers<never>();
    store.setCallbacks({ prepareSend: () => preparation.promise });
    const controller = new AbortController();
    const send = store.send({ message: "Hello", signal: controller.signal });
    controller.abort();
    await send;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.snapshot.status).toBe("ready");
  });

  it("aborts a send waiting for prewarm without cancelling shared session creation", async () => {
    const accepted = Promise.withResolvers<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(accepted.promise)
      .mockResolvedValueOnce(controlledStreamResponse().response);
    const store = createStore({ reducer: defaultMessageReducer() });
    const prewarm = store.prewarm();
    const controller = new AbortController();
    const send = store.send({ message: "Hello", signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await send;
    expect(store.snapshot.status).toBe("ready");
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    accepted.resolve(startedResponse());
    await prewarm;
    expect(store.snapshot.session?.sessionId).toBe("session_1");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["reset", "detach"] as const)("aborts prewarm transport on %s", async (action) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const store = createStore({ reducer: defaultMessageReducer() });
    const prewarm = expect(store.prewarm()).rejects.toMatchObject({ name: "AbortError" });
    const send = store.send({ message: "Hello" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    if (action === "reset") store.reset();
    else detachEveAgentStore(store);
    await Promise.all([prewarm, send]);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.session).toBeUndefined();
  });

  it("reports a standalone creation failure and allows another prewarm", async () => {
    const error = new Error("create failed");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse(stampTestEvents([createSessionWaitingEvent()])));
    const onError = vi.fn();
    const store = createStore({ reducer: defaultMessageReducer() });
    store.setCallbacks({ onError });

    await expect(store.prewarm()).rejects.toBe(error);
    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.error).toBe(error);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);

    await store.prewarm();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(store.snapshot.session?.sessionId).toBe("session_1");
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.error).toBeUndefined();
  });

  it("rejects prewarm when the first send it joined fails to create a session", async () => {
    const accepted = Promise.withResolvers<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(accepted.promise);
    const onError = vi.fn();
    const store = createStore({ reducer: defaultMessageReducer() });
    store.setCallbacks({ onError });
    const error = new Error("create failed");

    const send = store.send({ message: "Hello" });
    const prewarm = expect(store.prewarm()).rejects.toBe(error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    accepted.reject(error);
    await Promise.all([send, prewarm]);

    expect(store.snapshot.session).toBeUndefined();
    expect(store.snapshot.status).toBe("error");
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it.each([false, true])(
    "retries a waiting send after prewarm fails (send fails: %s)",
    async (sendFails) => {
      const accepted = Promise.withResolvers<Response>();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(accepted.promise);
      const sendError = new Error("send failed");
      if (sendFails) fetchMock.mockRejectedValueOnce(sendError);
      else
        fetchMock
          .mockResolvedValueOnce(startedResponse())
          .mockResolvedValueOnce(streamResponse(turnEvents()));
      const onError = vi.fn();
      const store = createStore({ reducer: defaultMessageReducer() });
      store.setCallbacks({ onError });
      const prewarmError = new Error("prewarm failed");

      const prewarm = expect(store.prewarm()).rejects.toBe(prewarmError);
      const send = store.send({ message: "Hello" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      accepted.reject(prewarmError);
      await Promise.all([prewarm, send]);

      expect(fetchMock.mock.calls[1]![0]).toBe("/eve/v1/session");
      expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({
        message: "Hello",
      });
      if (sendFails) {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledExactlyOnceWith(sendError);
        expect(store.snapshot.error).toBe(sendError);
        expect(store.snapshot.status).toBe("error");
      } else {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(onError).not.toHaveBeenCalled();
        expect(store.snapshot.error).toBeUndefined();
        expect(store.snapshot.status).toBe("ready");
        expect(store.snapshot.session?.sessionId).toBe("session_1");
      }
    },
  );

  it.each(["reset", "detach"] as const)(
    "does not retry a waiting send after %s",
    async (action) => {
      const accepted = Promise.withResolvers<Response>();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(accepted.promise);
      const onError = vi.fn();
      const store = createStore({ reducer: defaultMessageReducer() });
      store.setCallbacks({ onError });
      const error = new Error("prewarm failed");

      const prewarm = expect(store.prewarm()).rejects.toBe(error);
      const send = store.send({ message: "Hello" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      if (action === "reset") store.reset();
      else detachEveAgentStore(store);
      accepted.reject(error);
      await Promise.all([prewarm, send]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(store.snapshot.session).toBeUndefined();
      expect(store.snapshot.status).toBe("ready");
    },
  );

  it("shares one creation request without starting a turn", async () => {
    const accepted = Promise.withResolvers<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(accepted.promise)
      .mockResolvedValueOnce(streamResponse(stampTestEvents([createSessionWaitingEvent()])));
    const onFinish = vi.fn();
    const onSessionChange = vi.fn();
    const prepareSend = vi.fn();
    const store = createStore({ reducer: defaultMessageReducer() });
    store.setCallbacks({ onFinish, onSessionChange, prepareSend });

    const first = store.prewarm();
    const second = store.prewarm();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    accepted.resolve(
      Response.json({ ok: true, sessionId: "session_1", status: "accepted" }, { status: 202 }),
    );
    await first;

    expect(fetchMock.mock.calls[0]![1]!.body).toBeUndefined();
    expect(store.snapshot.session?.sessionId).toBe("session_1");
    expect(store.snapshot.status).toBe("ready");
    expect(onSessionChange).toHaveBeenCalledWith({ sessionId: "session_1", streamIndex: 0 });
    expect(prepareSend).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("discards a creation result after reset", async () => {
    const accepted = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(accepted.promise);
    const store = createStore({ reducer: defaultMessageReducer() });

    const prewarm = store.prewarm();
    store.reset();
    accepted.resolve(
      Response.json({ ok: true, sessionId: "stale_session", status: "accepted" }, { status: 202 }),
    );
    await prewarm;

    expect(store.snapshot.session).toBeUndefined();
  });

  it("sends before any stream event and keeps one stream across turns", async () => {
    const live = controlledStreamResponse();
    const accepted = Promise.withResolvers<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(accepted.promise)
      .mockResolvedValueOnce(live.response)
      .mockImplementation(async () => startedResponse());
    const store = createStore({ reducer: defaultMessageReducer() });
    const events = turnEvents().map((event) => ({
      ...event,
      meta: { ...event.meta, deliveryIds: ["delivery_1"] },
    }));

    const prewarm = store.prewarm();
    const firstSend = store.send({ message: "Hello" });
    accepted.resolve(startedResponse());
    await prewarm;
    expect(store.snapshot.events).toEqual([]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    for (const event of events) live.emit(event);
    await firstSend;
    expect(store.snapshot.status).toBe("ready");

    const secondSend = store.send({ message: "Hello again" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    for (const event of events)
      live.emit({ ...event, meta: { ...event.meta, id: `second-${event.meta.id}` } });
    await secondSend;
    expect(store.snapshot.status).toBe("ready");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(1);
    expect(store.snapshot.session?.streamIndex).toBe(6);
  });

  it("is ready at a held turn's waiting boundary and renders the turn's later reply", async () => {
    const live = controlledStreamResponse();
    const accepted = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(accepted.promise)
      .mockResolvedValueOnce(live.response)
      .mockImplementation(async () => startedResponse());
    const store = createStore({ reducer: defaultMessageReducer() });
    const [received, started, interim, heldCompleted, heldWaiting, final, completed, waiting] =
      stampTestEvents([
        createMessageReceivedEvent({ message: "Look up Q3.", sequence: 0, turnId: "turn_0" }),
        createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
        createMessageCompletedEvent({
          message: "Started the lookup.",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        }),
        createTurnCompletedEvent({ held: true, sequence: 0, turnId: "turn_0" }),
        createSessionWaitingEvent(),
        createMessageCompletedEvent({
          message: "Q3 revenue is 4.2M.",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        }),
        createTurnCompletedEvent({ sequence: 0, turnId: "turn_0" }),
        createSessionWaitingEvent(),
      ] as UnstampedMessageStreamEvent[]).map((event) => ({
        ...event,
        meta: { ...event.meta, deliveryIds: ["delivery_1"] },
      }));

    const sending = store.send({ message: "Look up Q3." });
    accepted.resolve(startedResponse());
    await vi.waitFor(() => expect(store.snapshot.status).toBe("submitted"));
    for (const event of [received, started, interim, heldCompleted, heldWaiting]) {
      live.emit(event!);
    }
    // The person can keep writing while the turn holds on its tasks.
    await sending;
    expect(store.snapshot.status).toBe("ready");

    for (const event of [final, completed, waiting]) live.emit(event!);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(8));
    expect(store.snapshot.status).toBe("ready");
    const replies = store.snapshot.data.messages.filter((message) => message.role === "assistant");
    expect(replies.map((message) => message.metadata)).toEqual([
      expect.objectContaining({ closed: true, turnId: "turn_0" }),
      expect.objectContaining({ closed: true, turnId: "turn_0" }),
    ]);
  });

  it("projects a background turn that arrives while another message is being accepted", async () => {
    const live = controlledStreamResponse();
    const accepted = Promise.withResolvers<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(live.response)
      .mockReturnValueOnce(accepted.promise);
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });
    const sending = store.send({ message: "Next question" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const background = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_background" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Background result",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_background",
      }),
      createSessionWaitingEvent(),
    ]).map((event) => ({
      ...event,
      meta: { ...event.meta, deliveryIds: ["background-delivery"] },
    }));
    for (const event of background) live.emit(event);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(3));
    expect(store.snapshot.data.messages.some((message) => message.metadata?.optimistic)).toBe(true);

    accepted.resolve(startedResponse("message-delivery"));
    const messageTurn = turnEvents().map((event) => ({
      ...event,
      meta: {
        ...event.meta,
        deliveryIds: ["message-delivery"],
        id: `message-${event.meta.id}`,
      },
    }));
    for (const event of messageTurn) live.emit(event);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(6));
    await sending;

    expect(store.snapshot.events).toEqual([...background, ...messageTurn]);
    expect(store.snapshot.data.messages.some((message) => message.metadata?.optimistic)).toBe(
      false,
    );
    expect(store.snapshot.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a send's disabled reconnect policy on an existing prewarmed stream", async () => {
    const live = controlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(live.response)
      .mockResolvedValueOnce(startedResponse());
    const store = createStore({ reducer: defaultMessageReducer() });
    await store.prewarm();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const send = store.send({ message: "Hello", streamReconnectPolicy: { reconnect: false } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    live.close();
    await send;
    expect(store.snapshot.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the latest turn headers when the continuous stream reconnects", async () => {
    const live = controlledStreamResponse();
    const reconnected = controlledStreamResponse();
    const streamAuthorizations: Array<string | null> = [];
    let delivery = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if (init?.method === "POST") return startedResponse(`delivery_${(delivery += 1)}`);
      streamAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return streamAuthorizations.length === 1 ? live.response : reconnected.response;
    });
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });
    const events = turnEvents();
    const emitTurn = (deliveryId: string, idPrefix: string) => {
      for (const event of events) {
        live.emit({
          ...event,
          meta: { ...event.meta, deliveryIds: [deliveryId], id: `${idPrefix}-${event.meta.id}` },
        });
      }
    };

    const first = store.send({
      headers: { authorization: "Bearer old" },
      message: "Hello",
      streamReconnectPolicy: {
        streamIdleReconnectPolicy: { baseDelayMs: 1, maxAttempts: 5, maxDelayMs: 1 },
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    emitTurn("delivery_1", "first");
    await first;

    const second = store.send({
      headers: { authorization: "Bearer fresh" },
      message: "Hello again",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    emitTurn("delivery_2", "second");
    await second;

    live.close();
    await vi.waitFor(() => expect(streamAuthorizations).toHaveLength(2));
    expect(streamAuthorizations).toEqual(["Bearer old", "Bearer fresh"]);
  });
});

describe("EveAgentStore stream overlap", () => {
  it("reconstructs a split message across an in-memory stream reconnect", async () => {
    const events = streamingTurnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(disconnectingStreamResponse(events.slice(0, 3)))
      .mockResolvedValueOnce(streamResponse(events.slice(3)));
    const store = createStore({ reducer: defaultMessageReducer() });
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

  it.each(["21", "24"] as const)(
    "reconstructs a split message across a v%s-to-v25 reconnect",
    async (legacyVersion) => {
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
      ] satisfies readonly MessageStreamEventForVersion<typeof legacyVersion>[];
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(startedResponse())
        .mockResolvedValueOnce(versionedDisconnectingStreamResponse(legacyVersion, legacyPrefix))
        .mockResolvedValueOnce(versionedStreamResponse("25", current.slice(3)));
      const store = createStore({ reducer: defaultMessageReducer() });
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
    },
  );

  it("rejects a prepared turn containing both a message and input responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const store = createStore({ reducer: defaultMessageReducer() });
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

    const store = createStore({
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

    const store = createStore({ reducer: defaultMessageReducer() });
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
    const store = createStore({
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
  it("resumes a saved session when Symbol.dispose is unavailable", async () => {
    const originalSymbol = globalThis.Symbol;
    const missingDisposeSymbol = new Proxy(
      function (description?: string) {
        return originalSymbol(description);
      },
      {
        get(_target, property) {
          if (property === "dispose") return undefined;
          return Reflect.get(originalSymbol, property);
        },
      },
    ) as typeof Symbol;
    Object.defineProperty(globalThis, "Symbol", {
      configurable: true,
      value: missingDisposeSymbol,
      writable: true,
    });
    vi.resetModules();

    try {
      const [{ EveAgentStore: FreshEveAgentStore }, { detachEveAgentStore: detachFreshStore }] =
        await Promise.all([import("#client/index.js"), import("#client/eve-agent-store.js")]);
      const events = turnEvents();
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(boundedStreamResponse(events))
        .mockResolvedValueOnce(boundedStreamResponse([], events.length - 1));
      const store = new FreshEveAgentStore({
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        reducer: defaultMessageReducer(),
      });

      try {
        await store.resume();
      } finally {
        detachFreshStore(store);
      }

      expect(store.snapshot.events).toEqual(events);
      expect(store.snapshot.status).toBe("ready");
    } finally {
      Object.defineProperty(globalThis, "Symbol", {
        configurable: true,
        value: originalSymbol,
        writable: true,
      });
      vi.resetModules();
    }
  });

  it("resumes an unused prewarmed session and sends its first message on the same stream", async () => {
    const live = controlledStreamResponse();
    live.response.headers.set("x-eve-stream-tail-index", "-1");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(live.response)
      .mockResolvedValueOnce(startedResponse());
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });
    const resuming = store.resume();

    await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"));
    await resuming;
    expect(store.snapshot.events).toEqual([]);

    const sending = store.send({ message: "Hello" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const event of turnEvents()) {
      live.emit({ ...event, meta: { ...event.meta, deliveryIds: ["delivery_1"] } });
    }
    await sending;

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(fetchMock.mock.calls[1]![0]).toBe("/eve/v1/session/session_1");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(1);
  });

  it.each([true, false])(
    "settles steering received while following a resumed turn (optimistic=%s)",
    async (optimistic) => {
      const events = stampTestEvents([
        createMessageReceivedEvent({ message: "First", sequence: 0, turnId: "turn_0" }),
        createTurnStartedEvent({ sequence: 1, turnId: "turn_0" }),
        createMessageReceivedEvent({ message: "Instead", sequence: 2, turnId: "turn_0" }),
        createMessageCompletedEvent({
          finishReason: "stop",
          message: "Updated reply.",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_0",
        }),
        createSessionWaitingEvent(),
      ]).map((event, index) =>
        index < 2 ? event : { ...event, meta: { ...event.meta, deliveryIds: ["delivery_1"] } },
      );
      const live = controlledStreamResponse();
      live.response.headers.set("x-eve-stream-tail-index", "1");
      live.emit(events[0]!);
      live.emit(events[1]!);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(live.response)
        .mockResolvedValueOnce(startedResponse());
      const store = createStore({
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        optimistic,
        reducer: defaultMessageReducer(),
      });
      const onFinish = vi.fn();
      store.setCallbacks({ onFinish });
      const resuming = store.resume();
      await vi.waitFor(() => expect(store.snapshot.status).toBe("streaming"));

      const steering = store.send({ message: "Instead", turnPolicy: "steer" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      for (const event of events.slice(2)) live.emit(event);

      await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"));
      await Promise.all([resuming, steering]);
      expect(store.snapshot.events).toEqual(events);
      expect(onFinish).toHaveBeenCalledOnce();
    },
  );

  it("finishes a settled replay without waiting for the probe stream to idle", async () => {
    const events = turnEvents();
    const probe = controlledStreamResponse();
    probe.response.headers.set("x-eve-stream-tail-index", String(events.length - 1));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events))
      .mockResolvedValueOnce(probe.response);
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    expect(store.snapshot.events).toEqual(events);
    expect(store.snapshot.status).toBe("ready");
  });

  it("continues a split message from a complete hydrated prefix", async () => {
    const events = streamingTurnEvents();
    const prefix = events.slice(0, 3);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse([events[3]!], 3))
      .mockResolvedValueOnce(streamResponse(events.slice(4)));
    const store = createStore({
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
    const store = createStore({
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
      .mockResolvedValueOnce(boundedStreamResponse([], events.length - 1));
    const store = createStore({
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
      .mockResolvedValueOnce(boundedStreamResponse([], events.length - 1));
    const store = createStore({
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
    const store = createStore({
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
    const store = createStore({
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

  it("catches up through the initial tail without opening a probe stream", async () => {
    const events = turnEvents();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events));
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });
    const publishedEventCounts: number[] = [];
    store.subscribe(() => publishedEventCounts.push(store.snapshot.events.length));

    await store.resume();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "startIndex",
      ),
    ).toBeNull();
    expect(
      new URL(fetchMock.mock.calls[0]![0].toString(), "http://localhost").searchParams.get(
        "includeTailIndex",
      ),
    ).toBe("1");
    expect(publishedEventCounts).toContain(events.length);
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
    const live = controlledStreamResponse();
    live.response.headers.set("x-eve-stream-tail-index", String(settled.length - 1));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live.response);
    for (const event of settled) live.emit(event);
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    for (const event of events.slice(settled.length)) live.emit(event);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(events.length));
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("reads past intermediate boundaries before following the latest turn", async () => {
    const events = stampTestEvents([
      ...turnEvents(),
      ...turnEvents(),
      createMessageReceivedEvent({ message: "Again", sequence: 0, turnId: "turn_3" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_3" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Latest reply.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_3",
      }),
      createSessionWaitingEvent(),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events, 7));
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual(events);
    expect(store.snapshot.session?.streamIndex).toBe(events.length);
  });

  it("keeps following when catch-up ends with pending authorization", async () => {
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
      createAuthorizationRequiredEvent({
        authorization: { url: "https://idp.example.com/authorize" },
        description: "Linear",
        name: "linear",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_2",
        webhookUrl: "https://agent.example.com/eve/v1/connections/linear/callback/hook",
      }),
      createSessionWaitingEvent(),
      createAuthorizationCompletedEvent({
        name: "linear",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const settled = events.slice(0, 3);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(boundedStreamResponse(events, settled.length + 1));
    const store = createStore({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toHaveLength(settled.length + 4);
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
    const store = createStore({
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
  it("prepares a steering message once when the active turn finishes during preparation", async () => {
    const live = controlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(live.response)
      .mockResolvedValueOnce(startedResponse("delivery_2"));
    const store = createStore({ reducer: defaultMessageReducer() });
    const first = store.send({ message: "First" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const preparation = Promise.withResolvers<void>();
    const prepareSend = vi.fn(async (input) => {
      await preparation.promise;
      return input;
    });
    store.setCallbacks({ prepareSend });
    const second = store.send({ message: "Second", turnPolicy: "steer" });
    for (const event of turnEvents()) live.emit(event);
    await first;
    preparation.resolve();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    for (const event of turnEvents())
      live.emit({
        ...event,
        meta: { ...event.meta, id: `second-${event.meta.id}`, deliveryIds: ["delivery_2"] },
      });
    await second;
    expect(prepareSend).toHaveBeenCalledOnce();
    expect(store.snapshot.status).toBe("ready");
  });

  it("aborts steering transport on reset without publishing into the new conversation", async () => {
    const live = controlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(live.response)
      .mockImplementationOnce(
        (_request, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    const store = createStore({ reducer: defaultMessageReducer() });
    const first = store.send({ message: "First" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const steering = expect(
      store.send({ message: "Instead", turnPolicy: "steer" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    store.reset();
    const onChange = vi.fn();
    store.subscribe(onChange);
    await Promise.all([first, steering]);
    expect(onChange).not.toHaveBeenCalled();
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual([]);
    expect(store.snapshot.error).toBeUndefined();
  });

  it.each([true, false])(
    "completes steering received in the active turn (optimistic=%s)",
    async (optimistic) => {
      const active = controlledStreamResponse();
      const events = stampTestEvents([
        createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
        createMessageReceivedEvent({ message: "First", sequence: 0, turnId: "turn_1" }),
        createMessageReceivedEvent({ message: "Instead", sequence: 0, turnId: "turn_1" }),
        createMessageCompletedEvent({
          finishReason: "stop",
          message: "Updated reply.",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_1",
        }),
        createSessionWaitingEvent(),
      ] as UnstampedMessageStreamEvent[]).map((event) => ({
        ...event,
        meta: { ...event.meta, deliveryIds: ["delivery_1"] },
      }));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(startedResponse())
        .mockResolvedValueOnce(active.response)
        .mockResolvedValueOnce(startedResponse());
      const store = createStore({ optimistic, reducer: defaultMessageReducer() });
      const initial = store.send({ message: "First" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      active.emit(events[0]!);
      active.emit(events[1]!);
      const steering = store.send({ message: "Instead", turnPolicy: "steer" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      for (const event of events.slice(2)) active.emit(event);
      active.close();
      await Promise.all([initial, steering]);
      expect(store.snapshot.status).toBe("ready");
      expect(store.snapshot.events).toEqual(events);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("settles steering whose delivery event arrives before its response", async () => {
    const activeStream = controlledStreamResponse();
    const steeringAccepted = Promise.withResolvers<Response>();
    const [firstReceived, firstStarted, steeringReceived, completed, waiting] = stampTestEvents([
      createMessageReceivedEvent({ message: "First", sequence: 0, turnId: "turn_1" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "Instead", sequence: 2, turnId: "turn_1" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Steered reply.",
        sequence: 3,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]).map((event, index) => ({
      ...event,
      meta: {
        ...event.meta,
        deliveryIds: [index === 2 ? "steering-delivery" : "first-delivery"],
      },
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse("first-delivery"))
      .mockResolvedValueOnce(activeStream.response)
      .mockReturnValueOnce(steeringAccepted.promise);
    const store = createStore({ reducer: defaultMessageReducer() });

    const firstSend = store.send({ message: "First" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    activeStream.emit(firstReceived!);
    activeStream.emit(firstStarted!);

    const steering = store.send({ message: "Instead", turnPolicy: "steer" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    activeStream.emit(steeringReceived!);
    activeStream.emit(completed!);
    activeStream.emit(waiting!);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(5));
    steeringAccepted.resolve(startedResponse("steering-delivery"));

    await Promise.all([firstSend, steering]);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages.some((message) => message.metadata?.optimistic)).toBe(
      false,
    );
  });

  it("follows a late steering delivery after the active turn settles", async () => {
    const activeStream = controlledStreamResponse();
    const [
      firstReceived,
      firstStarted,
      firstCompleted,
      firstWaiting,
      secondReceived,
      secondStarted,
      secondCompleted,
      secondWaiting,
    ] = stampTestEvents([
      createMessageReceivedEvent({ message: "First", sequence: 0, turnId: "turn_1" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "First reply.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ message: "Instead", sequence: 0, turnId: "turn_2" }),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_2" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Follow-up reply.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]).map((event, index) => ({
      ...event,
      meta: { ...event.meta, deliveryIds: [index < 4 ? "first-delivery" : "delivery_1"] },
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(activeStream.response)
      .mockResolvedValueOnce(startedResponse());
    const store = createStore({ reducer: defaultMessageReducer() });

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

    let settled = false;
    const finished = Promise.all([firstSend, steering]).then(() => {
      settled = true;
    });
    activeStream.emit(firstCompleted!);
    activeStream.emit(firstWaiting!);
    activeStream.emit(secondReceived!);
    activeStream.emit(secondStarted!);
    await vi.waitFor(() => expect(store.snapshot.events).toHaveLength(6));
    expect(settled).toBe(false);
    expect(store.snapshot.status).toBe("streaming");
    activeStream.emit(secondCompleted!);
    activeStream.emit(secondWaiting!);
    await finished;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toEqual([
      firstReceived,
      firstStarted,
      firstCompleted,
      firstWaiting,
      secondReceived,
      secondStarted,
      secondCompleted,
      secondWaiting,
    ]);
    expect(store.snapshot.data.messages.at(-1)?.parts).toContainEqual({
      state: "done",
      stepIndex: 0,
      text: "Follow-up reply.",
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
    const store = createStore({ reducer: defaultMessageReducer() });
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
    const store = createStore({ optimistic: false, reducer: defaultMessageReducer() });

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
    const store = createStore({ reducer: defaultMessageReducer() });

    await expect(store.cancel()).resolves.toEqual({ status: "no_active_turn" });
  });

  it("resolves a queued cancellation when reset wins before dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const store = createStore({ reducer: defaultMessageReducer() });

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
    const store = createStore({ reducer: defaultMessageReducer() });

    const sending = store.send({ message: "Hello" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    detachEveAgentStore(store);
    await sending;

    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.snapshot.status).toBe("ready");
  });
});
