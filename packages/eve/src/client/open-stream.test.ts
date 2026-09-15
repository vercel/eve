import { afterEach, describe, expect, it, vi } from "vitest";

import { followStreamIterable, openStreamBody } from "./open-stream.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_STREAM_IDLE_CLOSE_MS,
  EVE_SESSION_STREAM_READ_IDLE_TIMEOUT_MS,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openStreamBody", () => {
  it("cancels an opened response body when the stream follower closes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(body, {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
          status: 200,
        });
      }),
    );

    const connection = await openStreamBody({
      host: "https://agent.example",
      resolveHeaders: () => Promise.resolve(new Headers()),
      sessionId: "session_1",
      startIndex: 0,
    });
    connection.close();
    connection.close();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });
});

describe("followStreamIterable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects at once after the server closes an idle response", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const startIndices: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(
          typeof input === "string" ? input : (input as Request | URL).toString(),
        );
        startIndices.push(url.searchParams.get("startIndex"));
        const events =
          startIndices.length === 3
            ? [{ type: "turn.started", data: {}, meta: { deliveryIds: ["delivery_1"] } }]
            : [];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("\n"));
              for (const event of events) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              }
              controller.close();
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION }, status: 200 },
        );
      }),
    );

    const abort = new AbortController();
    const eventTypes: string[] = [];
    const consumed = (async () => {
      for await (const event of followStreamIterable({
        host: "https://agent.example",
        resolveHeaders: () => Promise.resolve(new Headers()),
        sessionId: "session_1",
        signal: abort.signal,
        startIndex: 4,
      })) {
        eventTypes.push(event.type);
        abort.abort();
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await consumed;

    expect(eventTypes).toEqual(["turn.started"]);
    expect(startIndices).toEqual(["4", "4", "4"]);
  });

  it("keeps following across clean idle closes until aborted", async () => {
    vi.useFakeTimers();
    let connections = 0;
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        connections += 1;
        if (connections === 20) abort.abort();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("\n"));
              controller.close();
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION }, status: 200 },
        );
      }),
    );

    const consumed = (async () => {
      for await (const _event of followStreamIterable({
        host: "https://agent.example",
        resolveHeaders: () => Promise.resolve(new Headers()),
        sessionId: "session_1",
        signal: abort.signal,
        startIndex: 0,
      })) {
        // no events expected
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await consumed;

    expect(connections).toBe(20);
  });

  it("stops after repeated empty connections that end abnormally", async () => {
    vi.useFakeTimers();
    let connections = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        connections += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION }, status: 200 },
        );
      }),
    );

    let settled = false;
    const consumed = (async () => {
      for await (const _event of followStreamIterable({
        host: "https://agent.example",
        resolveHeaders: () => Promise.resolve(new Headers()),
        sessionId: "session_1",
        startIndex: 0,
      })) {
        // no events expected
      }
    })().finally(() => {
      settled = true;
    });
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    await consumed;

    // Initial connection plus five counted idle retries.
    expect(connections).toBe(6);
  });
});

describe("stream idle timing", () => {
  it("lets the server close an idle response before the client abandons it", () => {
    expect(EVE_SESSION_STREAM_READ_IDLE_TIMEOUT_MS).toBeGreaterThan(
      EVE_SESSION_STREAM_IDLE_CLOSE_MS,
    );
  });
});
