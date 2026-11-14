import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/session-http.js";
import { encodeTestLine, testTurnFacts as turn } from "#internal/testing/events.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function session() {
  return new ClientSession(
    { baseUrl: "https://eve.test", resolveHeaders: async () => new Headers() },
    { sessionId: "session_1", streamIndex: 3 },
  );
}

/** A stream response that records when its body is cancelled. */
function stream(events: readonly SessionEvent[], onCancel = () => {}) {
  const body = events.map(encodeTestLine).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
      cancel: onCancel,
    }),
    { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
  );
}

function routes(get: () => Response, post: () => Promise<Response> | Response) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(String(request));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return init?.method === "POST" ? await post() : get();
  });
  return calls;
}

const accepted = () =>
  Response.json({ sessionId: "session_1", deliveryId: "new-delivery" }, { status: 202 });

describe("a send's stream", () => {
  it("opens as the send goes out, and the delivery's first read uses it", async () => {
    const calls = routes(
      () => stream(turn(1, "REPORT", ["new-delivery"])),
      () => accepted(),
    );

    const delivery = await session().send("report");
    expect(calls).toEqual([
      "POST /eve/v1/session/session_1",
      "GET /eve/v1/session/session_1/stream?startIndex=3",
    ]);
    expect((await delivery.result()).reply).toBe("REPORT");
    expect(calls).toHaveLength(2);
  });

  it("closes unread once the delivery has held it long enough", async () => {
    const cancelled = vi.fn();
    routes(
      () => stream([], cancelled),
      () => accepted(),
    );
    vi.useFakeTimers();

    await session().send("report");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toHaveBeenCalled();
  });

  it("closes when the send fails", async () => {
    const cancelled = vi.fn();
    routes(
      () => stream([], cancelled),
      () => Response.json({ error: "Failed.", ok: false }, { status: 500 }),
    );

    await expect(session().send("report")).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });

  it("is opened again by a read that finds it failed", async () => {
    let gets = 0;
    const calls = routes(
      () =>
        (gets += 1) === 1
          ? Response.json({ error: "Session not found.", ok: false }, { status: 404 })
          : stream(turn(1, "REPORT", ["new-delivery"])),
      () => accepted(),
    );

    const delivery = await session().send("report");
    expect((await delivery.result()).reply).toBe("REPORT");
    expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(2);
  });
});
