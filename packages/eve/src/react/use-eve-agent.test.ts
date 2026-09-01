import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEveAgent, type UseEveAgentHelpers } from "#react/use-eve-agent.js";
import type { EveMessageData } from "#client/message-reducer.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createTurnFailedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { ClientSessionState } from "#client/types.js";

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

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function optimisticUserData(message: string, status: "failed" | "submitted") {
  return {
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
});

describe("useEveAgent", () => {
  it("keeps the helpers object stable across renders without store changes", async () => {
    const seenHelpers: Array<UseEveAgentHelpers<EveMessageData>> = [];
    let root: ReturnType<typeof create> | undefined;

    function TestComponent({ label: _label }: { readonly label: string }) {
      seenHelpers.push(useEveAgent());
      return null;
    }

    await act(async () => {
      root = create(createElement(TestComponent, { label: "first" }));
    });

    const firstHelpers = seenHelpers.at(-1);

    await act(async () => {
      root?.update(createElement(TestComponent, { label: "second" }));
    });

    expect(seenHelpers.at(-1)).toBe(firstHelpers);
  });

  it("stops an active turn stream when the component unmounts", async () => {
    let streamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createStartedMessageResponse("session_1", "http:session_1");
      }

      streamSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamSignal?.addEventListener("abort", () => controller.error(createAbortError()));
          },
        }),
      );
    });

    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;
    let root: ReturnType<typeof create> | undefined;

    function TestComponent() {
      helpers = useEveAgent();
      return null;
    }

    await act(async () => {
      root = create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    expect(streamSignal?.aborted).toBe(false);

    await act(async () => {
      root?.unmount();
    });

    expect(streamSignal?.aborted).toBe(true);

    await act(async () => {
      await sendPromise;
    });
  });

  it("sends a message and projects streamed events with the default reducer", async () => {
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
      createSessionWaitingEvent(),
    ];

    const startResponse = createDeferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const lifecycle: string[] = [];
    const seenEvents: UnstampedMessageStreamEvent[] = [];
    const seenSessions: Array<ClientSessionState | undefined> = [];
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        credentials: "include",
        onEvent(event) {
          lifecycle.push(`event:${event.type}`);
          seenEvents.push(event);
        },
        onSessionChange(session) {
          lifecycle.push(`session:${String(session?.streamIndex)}`);
          seenSessions.push(session);
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await Promise.resolve();
    });

    expect(helpers?.status).toBe("submitted");
    expect(helpers?.events).toEqual([]);
    expect(helpers?.data).toEqual(optimisticUserData("Hello", "submitted"));

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
    expect(lifecycle[0]).toBe("session:0");
    expect(seenEvents).toEqual(stampTestEvents(events));
    expect(seenSessions).toEqual([
      {
        sessionId: "session_1",
        streamIndex: 0,
      },
      {
        sessionId: "session_1",
        streamIndex: 3,
      },
    ]);
    expect(helpers?.status).toBe("ready");
    expect(helpers?.session).toEqual({
      sessionId: "session_1",
      streamIndex: 3,
    });
    expect(helpers?.data).toEqual(
      completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );
  });

  it("detaches locally on unmount without cancelling the durable turn", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(createAbortError()), {
          once: true,
        });
      });
    });

    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent();
      return null;
    }

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    await act(async () => {
      renderer?.unmount();
    });
    await act(async () => {
      await sendPromise;
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prepares fresh clientContext before sending without projecting it optimistically", async () => {
    const startResponse = createDeferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent()]));

    let randomWord = "jazz";
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        prepareSend(input) {
          return {
            ...input,
            clientContext: { randomWord },
          };
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    randomWord = "waltz";

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("What word is currently selected?");
      await Promise.resolve();
    });

    expect(helpers?.status).toBe("submitted");
    expect(helpers?.data).toEqual(
      optimisticUserData("What word is currently selected?", "submitted"),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: {
        randomWord: "waltz",
      },
      message: "What word is currently selected?",
    });

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });
  });

  it("targets named agent routes when agent is configured", async () => {
    const startResponse = createDeferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent()]));

    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        agent: "support",
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await Promise.resolve();
    });

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/eve/agents/support/eve/v1/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/eve/agents/support/eve/v1/session/session_1/stream",
    );
  });

  it("marks an optimistic message as failed when send fails before confirmation", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    const seenErrors: Error[] = [];
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        onError(error) {
          seenErrors.push(error);
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    await act(async () => {
      await helpers?.send("Hello");
    });

    expect(seenErrors.map((error) => error.message)).toEqual(["Network failed"]);
    expect(helpers?.status).toBe("error");
    expect(helpers?.events).toEqual([]);
    expect(helpers?.data).toEqual(optimisticUserData("Hello", "failed"));
  });

  it("ignores stale send cleanup after reset starts a new message", async () => {
    const startFirstResponse = createDeferred<Response>();
    const startSecondResponse = createDeferred<Response>();
    const secondEvents = [
      createMessageReceivedEvent({
        message: "Second",
        sequence: 0,
        turnId: "turn_2",
      }),
      createMessageCompletedEvent({
        message: "Second reply.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createSessionWaitingEvent(),
    ];

    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startFirstResponse.promise)
      .mockReturnValueOnce(startSecondResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(secondEvents));

    const seenFinishes: Array<EveMessageData> = [];
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        onFinish(snapshot) {
          seenFinishes.push(snapshot.data);
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let firstSendPromise: Promise<void> | undefined;
    await act(async () => {
      firstSendPromise = helpers?.send("First");
      await Promise.resolve();
    });

    expect(helpers?.status).toBe("submitted");

    await act(async () => {
      helpers?.reset();
      await Promise.resolve();
    });

    let secondSendPromise: Promise<void> | undefined;
    await act(async () => {
      secondSendPromise = helpers?.send("Second");
      await Promise.resolve();
    });

    expect(helpers?.status).toBe("submitted");
    expect(helpers?.data).toEqual(optimisticUserData("Second", "submitted"));

    await act(async () => {
      startFirstResponse.reject(createAbortError());
      await firstSendPromise;
    });

    expect(helpers?.status).toBe("submitted");
    expect(helpers?.data).toEqual(optimisticUserData("Second", "submitted"));
    expect(seenFinishes).toEqual([]);

    await act(async () => {
      startSecondResponse.resolve(createStartedMessageResponse("session_2", "http:session_2"));
      await secondSendPromise;
    });

    expect(helpers?.status).toBe("ready");
    expect(helpers?.data).toEqual(
      completedTurnData({
        assistantMessage: "Second reply.",
        turnId: "turn_2",
        userMessage: "Second",
      }),
    );
    expect(seenFinishes).toEqual([helpers?.data]);
  });

  it("surfaces terminal stream failures as hook errors", async () => {
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

    const seenErrors: Error[] = [];
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        onError(error) {
          seenErrors.push(error);
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await Promise.resolve();
    });

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });

    expect(seenErrors.map((error) => error.message)).toEqual(["Bad Request"]);
    expect(seenErrors.map((error) => error.name)).toEqual(["MODEL_CALL_FAILED"]);
    expect(helpers?.status).toBe("error");
    expect(helpers?.error?.message).toBe("Bad Request");
    expect(helpers?.events).toEqual(stampTestEvents(events));
    expect(helpers?.data).toEqual(
      completedTurnData({
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );
  });

  it("does not surface recoverable step failures as hook errors", async () => {
    const events = [
      createMessageReceivedEvent({
        message: "Hello",
        sequence: 0,
        turnId: "turn_1",
      }),
      createStepFailedEvent({
        code: "MODEL_CALL_FAILED",
        message: "Recoverable model failure",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTurnFailedEvent({
        code: "MODEL_CALL_FAILED",
        message: "Recoverable model failure",
        sequence: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
    ];

    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const seenErrors: Error[] = [];
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;

    function TestComponent() {
      helpers = useEveAgent({
        onError(error) {
          seenErrors.push(error);
        },
      });
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.send("Hello");
      await Promise.resolve();
    });

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });

    expect(seenErrors).toEqual([]);
    expect(helpers?.status).toBe("ready");
    expect(helpers?.error).toBeUndefined();
    expect(helpers?.events).toEqual(stampTestEvents(events));
  });

  it("requires a session when automatic resume is enabled", async () => {
    function TestComponent() {
      useEveAgent({ resume: true });
      return null;
    }

    await expect(
      act(async () => {
        create(createElement(TestComponent));
      }),
    ).rejects.toThrow("requires initialSession or session");
  });

  it("keeps settled hydrated history visible without publishing an active-turn status", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createMessageCompletedEvent({
        message: "Hi there.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createSessionWaitingEvent(),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createBoundedStreamResponse([], events.length - 1))
      .mockResolvedValueOnce(createEagerStreamResponse([]));
    let helpers: UseEveAgentHelpers<EveMessageData> | undefined;
    const statuses: string[] = [];

    function TestComponent() {
      helpers = useEveAgent({
        initialEvents: events,
        initialSession: { sessionId: "session_1", streamIndex: events.length },
        resume: true,
      });
      statuses.push(helpers.status);
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
      await vi.waitFor(() => expect(helpers?.status).toBe("ready"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses[0]).toBe("resuming");
    expect(statuses).not.toContain("submitted");
    expect(statuses).not.toContain("streaming");
    expect(helpers?.status).toBe("ready");
    expect(helpers?.data).toEqual(
      completedTurnData({
        assistantMessage: "Hi there.",
        turnId: "turn_1",
        userMessage: "Hello",
      }),
    );
  });

  it("projects input responses before the resumed stream returns", async () => {
    const startResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(startResponse.promise)
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent()]));

    let helpers: UseEveAgentHelpers<readonly string[]> | undefined;

    function TestComponent() {
      helpers = useEveAgent<readonly string[]>({
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
      return null;
    }

    await act(async () => {
      create(createElement(TestComponent));
    });

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = helpers?.respond([{ optionId: "cancel", requestId: "approval_1" }]);
      await Promise.resolve();
    });

    expect(helpers?.status).toBe("submitted");
    expect(helpers?.data).toEqual(["client.input.responded"]);

    await act(async () => {
      startResponse.resolve(createStartedMessageResponse("session_1", "http:session_1"));
      await sendPromise;
    });

    expect(helpers?.status).toBe("ready");
    expect(helpers?.data).toEqual(["client.input.responded", "session.waiting"]);
  });
});
