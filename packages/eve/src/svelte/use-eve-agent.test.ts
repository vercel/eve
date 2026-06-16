import { afterEach, describe, expect, it, vi } from "vitest";

import { useEveAgent } from "#svelte/use-eve-agent.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useEveAgent (Svelte rune binding)", () => {
  it("renders the initial projection through plain reactive properties", () => {
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

    expect(agent.status).toBe("ready");
    expect(agent.data.messages).toHaveLength(2);
    expect(agent.session).toEqual({
      continuationToken: "http:session_1",
      sessionId: "session_1",
      streamIndex: 2,
    });
  });

  it("does not update the visible snapshot without browser reactivity", async () => {
    const agent = useEveAgent({
      initialEvents: [
        createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      ],
    });
    const dataBeforeSend = agent.data;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failed"));

    await agent.send({ message: "ignored" });

    expect(agent.data).toBe(dataBeforeSend);
    expect(agent.status).toBe("ready");
  });

  it("sends messages and notifies lifecycle callbacks from the shared store", async () => {
    vi.stubGlobal("window", {});
    const events = [
      createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_1", "http:session_1"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));
    const seenEvents: HandleMessageStreamEvent[] = [];

    const agent = useEveAgent({
      onEvent(event) {
        seenEvents.push(event);
      },
    });

    await agent.send({ message: "Hello" });

    expect(seenEvents).toEqual(events);
  });
});
