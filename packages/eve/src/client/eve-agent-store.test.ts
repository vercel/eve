import { afterEach, describe, expect, it, vi } from "vitest";

import { EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveMessageData } from "#client/message-reducer-types.js";
import { encodeTestLine, testTurnFacts } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import type { SessionEvent } from "#protocol/session-event.js";

afterEach(() => vi.restoreAllMocks());

/** A fake agent: each POST is accepted as the next delivery, and the stream serves `log`. */
function fakeAgent(turns: readonly ((deliveryId: string) => SessionEvent[])[]) {
  const log: SessionEvent[] = [];
  let deliveries = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    if ((init?.method ?? "GET") === "POST") {
      const deliveryId = `d_${deliveries}`;
      const turn = turns[deliveries];
      deliveries += 1;
      if (turn !== undefined) log.push(...turn(deliveryId));
      return Response.json(
        { deliveryId, ok: true, sessionId: "session_1", status: "accepted" },
        { status: 202 },
      );
    }
    const start = Number(url.searchParams.get("startIndex") ?? "0");
    const lines = log.slice(start).map(encodeTestLine);
    const signal = init?.signal ?? undefined;
    // Like the route, the stream stays open while the session is quiet, until the reader leaves.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join("")));
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    return new Response(body, {
      headers: {
        [EVE_STREAM_TAIL_INDEX_HEADER]: String(log.length - 1),
        [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
      },
    });
  });
  return log;
}

function userTexts(store: EveAgentStore<EveMessageData>): string[] {
  return store.snapshot.data.messages.map(
    (message) =>
      `${message.role}: ${message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}`,
  );
}

describe("EveAgentStore", () => {
  it("sends a message, reads its turn, and settles ready with one copy of each message", async () => {
    fakeAgent([(deliveryId) => testTurnFacts(0, "Sunny.", [deliveryId])]);
    const store = new EveAgentStore({ host: "https://eve.test", reducer: defaultMessageReducer() });
    const finished = vi.fn();
    store.setCallbacks({ onFinish: finished });

    const sent = store.send({ message: "sunny." });
    // The message shows at once, before the server confirms it.
    expect(userTexts(store)).toEqual(["user: sunny."]);
    await sent;

    expect(store.snapshot.status).toBe("ready");
    expect(userTexts(store)).toEqual(["user: sunny.", "assistant: Sunny."]);
    expect(store.snapshot.session).toEqual({ sessionId: "session_1", streamIndex: 8 });
    expect(finished).toHaveBeenCalledOnce();
  });

  it("resumes a saved session to its settled tail without repeating what it holds", async () => {
    const log = fakeAgent([]);
    log.push(...testTurnFacts(0, "Sunny.", ["d_0"]));
    const store = new EveAgentStore({
      host: "https://eve.test",
      initialSession: { sessionId: "session_1", streamIndex: 0 },
      reducer: defaultMessageReducer(),
    });

    await store.resume();

    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.events).toHaveLength(log.length);
    expect(userTexts(store)).toEqual(["user: sunny.", "assistant: Sunny."]);

    await store.resume();
    expect(store.snapshot.events).toHaveLength(log.length);
  });
});
