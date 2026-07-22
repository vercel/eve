import { afterEach, describe, expect, it, vi } from "vitest";

import { followStreamIterable, openStreamBody } from "#client/open-stream.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const TURN_STARTED: HandleMessageStreamEvent = {
  data: { sequence: 1, turnId: "turn-1" },
  type: "turn.started",
};

function createStreamResponse(events: readonly HandleMessageStreamEvent[]): Response {
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

async function collectEvents(
  events: AsyncIterable<HandleMessageStreamEvent>,
): Promise<HandleMessageStreamEvent[]> {
  const collected: HandleMessageStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("followStreamIterable current-tail snapshots", () => {
  it("composes one authenticated finite request and accepts its clean close", async () => {
    const resolveHeaders = vi.fn(async () => new Headers({ authorization: "Bearer fresh" }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createStreamResponse([TURN_STARTED]));

    await expect(
      collectEvents(
        followStreamIterable({
          host: "https://eve.test/proxy?token=secret&startIndex=stale",
          redirect: "manual",
          resolveHeaders,
          sessionId: "session_1",
          startIndex: 4,
          throughCurrentTail: true,
        }),
      ),
    ).resolves.toEqual([TURN_STARTED]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://eve.test/proxy/eve/v1/session/session_1/stream?token=secret&startIndex=4&throughCurrentTail=true",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer fresh",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(resolveHeaders).toHaveBeenCalledOnce();
  });

  it("overrides host reserved query keys with effective zero and true values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(createStreamResponse([]));

    await openStreamBody({
      host: "https://eve.test/proxy?token=secret&startIndex=-1&throughCurrentTail=false",
      resolveHeaders: async () => new Headers(),
      sessionId: "session_1",
      startIndex: 0,
      throughCurrentTail: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://eve.test/proxy/eve/v1/session/session_1/stream?token=secret&startIndex=0&throughCurrentTail=true",
    );
  });

  it("overrides host current-tail injection with the effective default false value", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(createStreamResponse([]));

    await openStreamBody({
      host: "https://eve.test/proxy?throughCurrentTail=true&token=secret",
      resolveHeaders: async () => new Headers(),
      sessionId: "session_1",
      startIndex: 4,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://eve.test/proxy/eve/v1/session/session_1/stream?throughCurrentTail=false&token=secret&startIndex=4",
    );
  });

  it("retries transient failures before a response body without recapturing after open", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(createStreamResponse([]));

    vi.useFakeTimers();
    const consumed = collectEvents(
      followStreamIterable({
        host: "https://eve.test",
        resolveHeaders: async () => new Headers(),
        sessionId: "session_1",
        startIndex: 0,
        throughCurrentTail: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(consumed).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [request] of fetchMock.mock.calls) {
      expect(new URL(String(request)).searchParams.get("throughCurrentTail")).toBe("true");
    }
  });

  it("fails an interrupted finite body instead of reconnecting to a new snapshot", async () => {
    const encoder = new TextEncoder();
    let pulled = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!pulled) {
              pulled = true;
              controller.enqueue(encoder.encode(`${JSON.stringify(TURN_STARTED)}\n`));
              return;
            }
            controller.error(new Error("socket disconnected"));
          },
        }),
      ),
    );

    await expect(
      collectEvents(
        followStreamIterable({
          host: "https://eve.test",
          resolveHeaders: async () => new Headers(),
          sessionId: "session_1",
          startIndex: 0,
          throughCurrentTail: true,
        }),
      ),
    ).rejects.toThrow("socket disconnected");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats caller abort as cancellation rather than snapshot failure", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_request, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`${JSON.stringify(TURN_STARTED)}\n`));
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
    );
    const received: HandleMessageStreamEvent[] = [];

    for await (const event of followStreamIterable({
      host: "https://eve.test",
      resolveHeaders: async () => new Headers(),
      sessionId: "session_1",
      signal: abortController.signal,
      startIndex: 0,
      throughCurrentTail: true,
    })) {
      received.push(event);
      abortController.abort();
    }

    expect(received).toEqual([TURN_STARTED]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels the response body when a finite consumer stops early", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel,
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(TURN_STARTED)}\n`));
          },
        }),
      ),
    );

    for await (const _event of followStreamIterable({
      host: "https://eve.test",
      resolveHeaders: async () => new Headers(),
      sessionId: "session_1",
      startIndex: 0,
      throughCurrentTail: true,
    })) {
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
  });
});
