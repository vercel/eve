import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import {
  detachEveAgentStore,
  EveAgentStore,
  type EveAgentStoreSnapshot,
} from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { ClientSessionState } from "#client/types.js";
import { useEveAgent } from "#vue/use-eve-agent.js";
import type { EveMessageData } from "#client/message-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createSessionFailedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { TEST_USAGE, stampTestEvents } from "#internal/testing/events.js";

function createStartedMessageResponse(sessionId: string, continuationToken: string): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true, sessionId }), {
    headers: {
      "content-type": "application/json",
      [EVE_SESSION_ID_HEADER]: sessionId,
    },
    status: 202,
  });
}

function createEagerStreamResponse(events: readonly UnstampedMessageStreamEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of stampTestEvents(events)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
    {
      headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
    },
  );
}

function createBoundedStreamResponse(
  events: readonly UnstampedMessageStreamEvent[],
  tailIndex = events.length - 1,
): Response {
  const response = createEagerStreamResponse(events);
  response.headers.set("x-eve-stream-tail-index", String(tailIndex));
  return response;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function optimisticUserData(message: string, status: "failed" | "submitted") {
  return {
    tasks: {},
    agents: {},
    inputs: {},
    turns: {},
    messages: [
      {
        id: expect.stringMatching(/^optimistic:/),
        metadata: {
          optimistic: true,
          status,
        },
        parts: [{ text: message, type: "text" }],
        role: "user",
      },
    ],
  };
}

function completedTurnData(input: {
  readonly assistantMessage?: string;
  readonly turnId: string;
  readonly userMessage: string;
}): ConversationState {
  return {
    tasks: {},
    agents: {},
    inputs: {},
    turns: {},
    messages: [
      {
        id: expect.stringMatching(/^evt_.+:user$/),
        metadata: {
          status: "complete",
          turnId: input.turnId,
        },
        parts: [{ state: "done", text: input.userMessage, type: "text" }],
        role: "user",
      },
      ...(input.assistantMessage === undefined
        ? []
        : [
            {
              id: `${input.turnId}:assistant`,
              metadata: {
                status: "complete" as const,
                turnId: input.turnId,
              },
              parts: [
                { type: "step-start" as const },
                {
                  id: expect.stringMatching(/^evt_/),
                  state: "done" as const,
                  stepIndex: 0,
                  text: input.assistantMessage,
                  type: "text" as const,
                },
              ],
              role: "assistant" as const,
            },
          ]),
    ],
  };
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

describe("EveAgentStore (Vue composable backing store)", () => {
  it("starts in ready status with empty data", () => {
    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages).toEqual([]);
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.events).toEqual([]);
  });

  it("notifies subscribers on state changes", async () => {
    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    const snapshots: EveAgentStoreSnapshot<EveMessageData>[] = [];
    store.subscribe(() => {
      snapshots.push(store.snapshot);
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    await store.send({ message: "Hello" });

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.status).toBe("error");
  });

  it("sends a message and projects streamed events", async () => {
    const events = [
      createMessageReceivedEvent({
        message: "Hello",
        sequence: 0,
        turnId: "turn_1",
      }),
      createMessageCompletedEvent({
        message: "Hi there.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(TEST_USAGE),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    const seenEvents: UnstampedMessageStreamEvent[] = [];
    const seenSessions: Array<ClientSessionState | undefined> = [];
    store.setCallbacks({
      onEvent(event) {
        seenEvents.push(event);
      },
      onSessionChange(session) {
        seenSessions.push(session);
      },
    });

    const sendPromise = store.send({ message: "Hello" });
    await Promise.resolve();

    expect(store.snapshot.status).toBe("submitted");
    expect(store.snapshot.data).toEqual({
      messages: [
        {
          id: expect.stringMatching(/^optimistic:/),
          metadata: { optimistic: true, status: "submitted" },
          parts: [{ text: "Hello", type: "text" }],
          role: "user",
        },
      ],
    });

    startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
    await sendPromise;

    expect(seenEvents).toEqual(stampTestEvents(events));
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data).toEqual({
      messages: completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }).messages,
    });
    expect(seenSessions.map((session) => session?.streamIndex)).toEqual([0, 1, 2, 3, 3]);
  });

  it("surfaces transport errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    const seenErrors: Error[] = [];
    store.setCallbacks({
      onError(error) {
        seenErrors.push(error);
      },
    });

    await store.send({ message: "Hello" });

    expect(seenErrors.map((e) => e.message)).toEqual(["Network failed"]);
    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.error?.message).toBe("Network failed");
  });

  it("surfaces terminal stream failures as store errors", async () => {
    const events = [
      createMessageReceivedEvent({
        message: "Hello",
        sequence: 0,
        turnId: "turn_1",
      }),
      createSessionFailedEvent({
        usage: TEST_USAGE,
        code: "MODEL_CALL_FAILED",
        message: "Bad Request",
        sessionId: "session_1",
      }),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    const seenErrors: Error[] = [];
    store.setCallbacks({
      onError(error) {
        seenErrors.push(error);
      },
    });

    const sendPromise = store.send({ message: "Hello" });
    startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
    await sendPromise;

    expect(seenErrors.map((e) => e.message)).toEqual(["Bad Request"]);
    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.error?.message).toBe("Bad Request");
  });

  it("resets state and creates a new session", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"));

    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    await store.send({ message: "Hello" });
    expect(store.snapshot.status).toBe("error");

    store.reset();
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages).toEqual([]);
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.events).toEqual([]);
  });

  it("unsubscribe removes the listener", () => {
    const store = createStore({
      reducer: defaultMessageReducer(),
    });

    let callCount = 0;
    const unsub = store.subscribe(() => {
      callCount += 1;
    });

    store.reset();
    expect(callCount).toBe(1);

    unsub();
    store.reset();
    expect(callCount).toBe(1);
  });

  it("projects input responses before the resumed stream returns", async () => {
    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) =>
      init?.method === "POST"
        ? await startResponse.promise
        : createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]),
    );

    const store = createStore<readonly string[]>({
      initialSession: {
        sessionId: "session_1",
        streamIndex: 0,
      },
      reducer: {
        initial() {
          return [];
        },
        reduce(data, event) {
          return [...data, event.type];
        },
      },
    });

    const sendPromise = store.send({
      inputResponses: [{ optionId: "cancel", requestId: "approval_1" }],
    });
    await Promise.resolve();

    expect(store.snapshot.status).toBe("submitted");
    expect(store.snapshot.data).toEqual(["client.input.responded"]);

    startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
    await sendPromise;

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data).toEqual(["client.input.responded", "session.waiting"]);
  });
});

describe("useEveAgent (Vue composable wiring)", () => {
  it("automatically replays an initial session when resume is enabled", async () => {
    vi.stubGlobal("window", {});
    const events = [
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createMessageCompletedEvent({
        message: "Hi there.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(TEST_USAGE),
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createBoundedStreamResponse(events))
      .mockResolvedValueOnce(createBoundedStreamResponse([], events.length - 1));
    const scope = effectScope();
    const agent = scope.run(() =>
      useEveAgent({
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        resume: true,
      }),
    );
    if (agent === undefined) throw new Error("effect scope did not run");

    expect(agent.status.value).toBe("resuming");
    await vi.waitFor(() => expect(agent.events.value).toHaveLength(events.length));
    expect(agent.status.value).toBe("ready");
    expect(agent.data.value).toEqual(
      completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );

    scope.stop();
  });

  it("projects streamed events into reactive refs in the browser", async () => {
    vi.stubGlobal("window", {});
    const events = [
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createMessageCompletedEvent({
        message: "Hi there.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(TEST_USAGE),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ prewarm: false }));
    if (agent === undefined) throw new Error("effect scope did not run");

    expect(agent.status.value).toBe("ready");
    expect(agent.data.value.messages).toEqual([]);

    const sendPromise = agent.send("Hello");
    await Promise.resolve();
    expect(agent.status.value).toBe("submitted");

    startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
    await sendPromise;

    expect(agent.status.value).toBe("ready");
    expect(agent.data.value).toEqual(
      completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );

    scope.stop();
  });

  it("unsubscribes and detaches the local stream when the scope is disposed", async () => {
    vi.stubGlobal("window", {});
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(
        createEagerStreamResponse([
          createMessageReceivedEvent({ message: "After", sequence: 0, turnId: "turn_1" }),
          createSessionWaitingEvent(TEST_USAGE),
        ]),
      );

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ prewarm: false }));
    if (agent === undefined) throw new Error("effect scope did not run");

    const dataBeforeDispose = agent.data.value;
    scope.stop();

    await agent.send("After");

    expect(agent.data.value).toBe(dataBeforeDispose);
    expect(agent.data.value.messages).toEqual([]);
  });

  it("prewarms a session on scope run when prewarm is enabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_request, init) =>
        init?.method === "POST"
          ? createStartedMessageResponse("session_1", "")
          : createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]),
      );

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ prewarm: true }));
    if (agent === undefined) throw new Error("effect scope did not run");

    await vi.waitFor(() => expect(agent.session.value?.sessionId).toBe("session_1"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/eve/v1/session");

    scope.stop();
  });

  it("does not prewarm a session when prewarm is disabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const scope = effectScope();
    scope.run(() => useEveAgent({ prewarm: false }));
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();

    scope.stop();
  });

  it("keeps the stream closed while prewarming when followIdle is disabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => createStartedMessageResponse("session_1", ""));

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ followIdle: false, prewarm: true }));
    if (agent === undefined) throw new Error("effect scope did not run");

    await vi.waitFor(() => expect(agent.session.value?.sessionId).toBe("session_1"));
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method !== "POST",
      ),
    ).toEqual([]);

    scope.stop();
  });

  it("targets named agent routes when agent is configured", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]));

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ agent: "support", prewarm: false }));
    if (agent === undefined) throw new Error("effect scope did not run");

    await agent.send("Hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/eve/support/v1/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/eve/support/v1/session/session_1/stream?streamControlVersion=1",
    );

    scope.stop();
  });

  it("prepares fresh clientContext before sending", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]));

    let randomWord = "jazz";
    const scope = effectScope();
    const agent = scope.run(() =>
      useEveAgent({
        prewarm: false,
        prepareSend: (input) => ({ ...input, clientContext: { randomWord } }),
      }),
    );
    if (agent === undefined) throw new Error("effect scope did not run");

    randomWord = "waltz";
    await agent.send("What word is currently selected?");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: { randomWord: "waltz" },
      message: "What word is currently selected?",
    });

    scope.stop();
  });

  it("marks an optimistic message as failed when send fails before confirmation", async () => {
    vi.stubGlobal("window", {});
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    const seenErrors: Error[] = [];
    const scope = effectScope();
    const agent = scope.run(() =>
      useEveAgent({
        prewarm: false,
        onError(error) {
          seenErrors.push(error);
        },
      }),
    );
    if (agent === undefined) throw new Error("effect scope did not run");

    await agent.send("Hello");

    expect(seenErrors.map((error) => error.message)).toEqual(["Network failed"]);
    expect(agent.status.value).toBe("error");
    expect(agent.data.value).toEqual(optimisticUserData("Hello", "failed"));

    scope.stop();
  });

  it("detaches an active turn stream on scope dispose without cancelling the turn", async () => {
    vi.stubGlobal("window", {});
    let streamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createStartedMessageResponse("session_1", "http:session_1");
      }

      streamSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamSignal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
        { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
      );
    });

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent({ prewarm: false }));
    if (agent === undefined) throw new Error("effect scope did not run");

    const sendPromise = agent.send("Hello");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(streamSignal?.aborted).toBe(false);

    scope.stop();

    expect(streamSignal?.aborted).toBe(true);
    // Detaching abandons the local stream only; no cancel request is sent.
    expect(fetchMock.mock.calls.filter(([request]) => String(request).endsWith("/cancel"))).toEqual(
      [],
    );
    await sendPromise.catch(() => {});
  });

  it("responds to a pending input request and resets the projection", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_request, init) =>
        init?.method === "POST"
          ? createStartedMessageResponse("session_1", "http:session_1")
          : createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]),
      );

    const scope = effectScope();
    const agent = scope.run(() =>
      useEveAgent({
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        prewarm: false,
      }),
    );
    if (agent === undefined) throw new Error("effect scope did not run");

    await agent.respond([{ optionId: "cancel", requestId: "approval_1" }]);

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    if (postCall === undefined) throw new Error("expected a POST request");
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      inputResponses: [{ optionId: "cancel", requestId: "approval_1" }],
    });
    expect(agent.events.value.length).toBeGreaterThan(0);

    agent.reset();

    expect(agent.status.value).toBe("ready");
    expect(agent.events.value).toEqual([]);
    expect(agent.data.value.messages).toEqual([]);

    scope.stop();
  });

  it("renders initial projection without subscribing during SSR", async () => {
    const agent = useEveAgent({
      initialEvents: stampTestEvents([
        createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
        createMessageCompletedEvent({
          message: "Hi there.",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ]),
      initialSession: {
        sessionId: "session_1",
        streamIndex: 2,
      },
    });

    expect(agent.status.value).toBe("ready");
    expect(agent.data.value.messages.length).toBeGreaterThan(0);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));
    const dataBeforeSend = agent.data.value;
    await agent.send("ignored");

    expect(agent.data.value).toBe(dataBeforeSend);
    expect(agent.status.value).toBe("ready");
  });
});
