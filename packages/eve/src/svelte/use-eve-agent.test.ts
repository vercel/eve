import { afterEach, describe, expect, it, vi } from "vitest";

import { useEveAgent } from "#svelte/use-eve-agent.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
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

const cleanupMounts: Array<() => void> = [];
vi.mock("svelte", () => ({
  onMount: (callback: () => () => void) => {
    cleanupMounts.push(callback());
  },
}));

afterEach(() => {
  for (const cleanup of cleanupMounts.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useEveAgent (Svelte rune binding)", () => {
  it("renders the initial projection through plain reactive properties", () => {
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

    expect(agent.status).toBe("ready");
    expect(agent.data.messages).toHaveLength(2);
    expect(agent.session).toEqual({
      sessionId: "session_1",
      streamIndex: 2,
    });
  });

  it("does not update the visible snapshot without browser reactivity", async () => {
    const agent = useEveAgent({
      initialEvents: stampTestEvents([
        createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      ]),
    });
    const dataBeforeSend = agent.data;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    await agent.send("ignored");

    expect(agent.data).toBe(dataBeforeSend);
    expect(agent.status).toBe("ready");
  });

  it("automatically replays an initial session when resume is enabled", async () => {
    vi.stubGlobal("window", {});
    const events = [
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createSessionWaitingEvent(TEST_USAGE),
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createBoundedStreamResponse(events))
      .mockResolvedValueOnce(createBoundedStreamResponse([], events.length - 1));
    const seenEvents: UnstampedMessageStreamEvent[] = [];

    useEveAgent({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      resume: true,
      onEvent(event) {
        seenEvents.push(event);
      },
    });

    await vi.waitFor(() => expect(seenEvents).toEqual(stampTestEvents(events)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends messages and notifies lifecycle callbacks from the shared store", async () => {
    vi.stubGlobal("window", {});
    const events = [
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createSessionWaitingEvent(TEST_USAGE),
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));
    const seenEvents: UnstampedMessageStreamEvent[] = [];

    const agent = useEveAgent({
      prewarm: false,
      onEvent(event) {
        seenEvents.push(event);
      },
    });

    await agent.send("Hello");

    expect(seenEvents).toEqual(stampTestEvents(events));
  });

  it("prewarms a session on mount when prewarm is enabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_request, init) =>
        init?.method === "POST"
          ? createStartedMessageResponse("session_1", "")
          : createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]),
      );

    const seenSessions: Array<string | undefined> = [];
    useEveAgent({
      prewarm: true,
      onSessionChange(session) {
        seenSessions.push(session?.sessionId);
      },
    });

    await vi.waitFor(() => expect(seenSessions).toContain("session_1"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/eve/v1/session");
  });

  it("does not prewarm a session when prewarm is disabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.spyOn(globalThis, "fetch");

    useEveAgent({ prewarm: false });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the stream closed while prewarming when followIdle is disabled", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => createStartedMessageResponse("session_1", ""));

    const seenSessions: Array<string | undefined> = [];
    useEveAgent({
      followIdle: false,
      prewarm: true,
      onSessionChange(session) {
        seenSessions.push(session?.sessionId);
      },
    });

    await vi.waitFor(() => expect(seenSessions).toContain("session_1"));
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method !== "POST",
      ),
    ).toEqual([]);
  });

  it("targets named agent routes when agent is configured", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]));

    const agent = useEveAgent({ agent: "support", prewarm: false });
    await agent.send("Hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/eve/support/v1/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/eve/support/v1/session/session_1/stream?streamControlVersion=1",
    );
  });

  it("prepares fresh clientContext before sending", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse([createSessionWaitingEvent(TEST_USAGE)]));

    let randomWord = "jazz";
    const agent = useEveAgent({
      prewarm: false,
      prepareSend: (input) => ({ ...input, clientContext: { randomWord } }),
    });

    randomWord = "waltz";
    await agent.send("What word is currently selected?");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: { randomWord: "waltz" },
      message: "What word is currently selected?",
    });
  });

  it("reports a send that fails before confirmation without opening a stream", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network failed"));

    const seenErrors: Error[] = [];
    const agent = useEveAgent({
      prewarm: false,
      onError(error) {
        seenErrors.push(error);
      },
    });

    await agent.send("Hello");

    expect(seenErrors.map((error) => error.message)).toEqual(["Network failed"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces terminal stream failures as binding errors", async () => {
    vi.stubGlobal("window", {});
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(
        createEagerStreamResponse([
          createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
          createSessionFailedEvent({
            usage: TEST_USAGE,
            code: "MODEL_CALL_FAILED",
            message: "Bad Request",
            sessionId: "session_1",
          }),
        ]),
      );

    const seenErrors: Error[] = [];
    const agent = useEveAgent({
      prewarm: false,
      onError(error) {
        seenErrors.push(error);
      },
    });

    await agent.send("Hello");

    expect(seenErrors.map((error) => error.message)).toEqual(["Bad Request"]);
    expect(seenErrors.map((error) => error.name)).toEqual(["MODEL_CALL_FAILED"]);
  });

  it("detaches an active turn stream on destroy without cancelling the turn", async () => {
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

    const agent = useEveAgent({ prewarm: false });
    const sendPromise = agent.send("Hello");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(streamSignal?.aborted).toBe(false);

    for (const cleanup of cleanupMounts.splice(0)) cleanup();

    expect(streamSignal?.aborted).toBe(true);
    // Destroying the component abandons the local stream only; the durable
    // turn keeps running, so no cancel request is sent.
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

    const seenEvents: UnstampedMessageStreamEvent[] = [];
    const agent = useEveAgent({
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      prewarm: false,
      onEvent(event) {
        seenEvents.push(event);
      },
    });

    await agent.respond([{ optionId: "cancel", requestId: "approval_1" }]);

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    if (postCall === undefined) throw new Error("expected a POST request");
    expect(String(postCall[0])).toBe("/eve/v1/session/session_1");
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      inputResponses: [{ optionId: "cancel", requestId: "approval_1" }],
    });
    expect(seenEvents.length).toBeGreaterThan(0);

    agent.reset();
    await agent.send("Hello again");

    // reset() drops the bound session, so the next turn creates a new one.
    expect(String(fetchMock.mock.calls.at(-2)?.[0])).toBe("/eve/v1/session");
  });
});
