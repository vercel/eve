import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import { useEveAgent } from "#vue/use-eve-agent.js";
import type { EveMessageData } from "#client/message-reducer.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { stampTestEvents } from "#internal/testing/events.js";

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

function completedTurnData(input: {
  readonly assistantMessage?: string;
  readonly turnId: string;
  readonly userMessage: string;
}): EveMessageData {
  return {
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
      createSessionWaitingEvent(),
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
      createSessionWaitingEvent(),
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
          createSessionWaitingEvent(),
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
