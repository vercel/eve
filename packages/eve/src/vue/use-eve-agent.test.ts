import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import { EveAgentStore, type EveAgentStoreSnapshot } from "#client/eve-agent-store.js";
import { useEveAgent } from "#vue/use-eve-agent.js";
import type { EveMessageData } from "#client/message-reducer.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { SessionState } from "#client/types.js";

function createStartedMessageResponse(sessionId: string, continuationToken: string): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true, sessionId }), {
    headers: {
      "content-type": "application/json",
      [EVE_SESSION_ID_HEADER]: sessionId,
    },
    status: 202,
  });
}

function createEagerStreamResponse(events: readonly HandleMessageStreamEvent[]): Response {
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function completedTurnData(input: {
  readonly assistantMessage?: string;
  readonly turnId: string;
  readonly userMessage: string;
}): EveMessageData {
  return {
    messages: [
      {
        id: `${input.turnId}:user`,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EveAgentStore (Vue composable backing store)", () => {
  it("starts in ready status with empty data", () => {
    const store = new EveAgentStore({
      reducer: defaultMessageReducer(),
    });

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data.messages).toEqual([]);
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.events).toEqual([]);
  });

  it("notifies subscribers on state changes", async () => {
    const store = new EveAgentStore({
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
      createSessionWaitingEvent("eve:http:session_1"),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const store = new EveAgentStore({
      reducer: defaultMessageReducer(),
    });

    const seenEvents: HandleMessageStreamEvent[] = [];
    const seenSessions: SessionState[] = [];
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

    expect(seenEvents).toEqual(events);
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.data).toEqual(
      completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );
    expect(seenSessions).toEqual([
      {
        continuationToken: "http:session_1",
        sessionId: "session_1",
        streamIndex: 3,
      },
    ]);
  });

  it("surfaces transport errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    const store = new EveAgentStore({
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
        code: "MODEL_CALL_FAILED",
        message: "Bad Request",
        sessionId: "session_1",
      }),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const store = new EveAgentStore({
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

    const store = new EveAgentStore({
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
    const store = new EveAgentStore({
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
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(
        createEagerStreamResponse([createSessionWaitingEvent("eve:http:session_1")]),
      );

    const store = new EveAgentStore<readonly string[]>({
      initialSession: {
        continuationToken: "http:session_1",
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
      inputResponses: [{ optionId: "deny", requestId: "approval_1" }],
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
      createSessionWaitingEvent("eve:http:session_1"),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent());
    if (agent === undefined) throw new Error("effect scope did not run");

    expect(agent.status.value).toBe("ready");
    expect(agent.data.value.messages).toEqual([]);

    const sendPromise = agent.send({ message: "Hello" });
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

  it("unsubscribes and stops the session when the scope is disposed", async () => {
    vi.stubGlobal("window", {});
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(
        createEagerStreamResponse([
          createMessageReceivedEvent({ message: "After", sequence: 0, turnId: "turn_1" }),
          createSessionWaitingEvent("eve:http:session_1"),
        ]),
      );

    const scope = effectScope();
    const agent = scope.run(() => useEveAgent());
    if (agent === undefined) throw new Error("effect scope did not run");

    const dataBeforeDispose = agent.data.value;
    scope.stop();

    await agent.send({ message: "After" });

    expect(agent.data.value).toBe(dataBeforeDispose);
    expect(agent.data.value.messages).toEqual([]);
  });

  it("renders initial projection without subscribing during SSR", async () => {
    const agent = useEveAgent({
      initialEvents: [
        createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
        createMessageCompletedEvent({
          message: "Hi there.",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ],
      initialSession: {
        continuationToken: "http:session_1",
        sessionId: "session_1",
        streamIndex: 2,
      },
    });

    expect(agent.status.value).toBe("ready");
    expect(agent.data.value.messages.length).toBeGreaterThan(0);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));
    const dataBeforeSend = agent.data.value;
    await agent.send({ message: "ignored" });

    expect(agent.data.value).toBe(dataBeforeSend);
    expect(agent.status.value).toBe("ready");
  });
});
