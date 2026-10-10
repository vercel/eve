import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session } from "#channel/session.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import {
  EVE_STREAM_CONTROL_VERSION,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_LEASE_ENDED_CONTROL,
} from "#protocol/message.js";

const encoder = new TextEncoder();

function stubSession(events: ReadableStream<unknown>, tailIndex = -1): Session {
  return {
    id: "session_1",
    async getEventStream() {
      return events;
    },
    async getStreamTailIndex() {
      return tailIndex;
    },
  } as Session;
}

/** A durable byte source that never reaches EOF, like a parked run's stream. */
function openByteSource(lines: number): {
  readonly source: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
} {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < lines; i += 1) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ sequence: i })}\n`));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { cancelled: () => cancelled, source };
}

function leasedRequest(): Request {
  const url = new URL("https://eve.test/eve/v1/session/session_1/stream");
  url.searchParams.set(EVE_STREAM_CONTROL_VERSION_QUERY, EVE_STREAM_CONTROL_VERSION);
  return new Request(url);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionStreamResponse", () => {
  it("ends a negotiated response after its lease and cancels the source", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const events = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    const response = await createSessionStreamResponse(leasedRequest(), stubSession(events));
    const reader = response.body!.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: encoder.encode("\n") });
    for (let elapsed = 10_000; elapsed < 60_000; elapsed += 10_000) {
      const heartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(heartbeat).resolves.toEqual({ done: false, value: encoder.encode("\n") });
    }

    const control = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(control).resolves.toEqual({
      done: false,
      value: encoder.encode(`${JSON.stringify(EVE_STREAM_LEASE_ENDED_CONTROL)}\n`),
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("resets heartbeats after events without extending the lease", async () => {
    vi.useFakeTimers();
    let eventController: ReadableStreamDefaultController<unknown> | undefined;
    const events = new ReadableStream({
      start(controller) {
        eventController = controller;
      },
    });

    const response = await createSessionStreamResponse(leasedRequest(), stubSession(events));
    const reader = response.body!.getReader();
    await reader.read();

    await vi.advanceTimersByTimeAsync(9_000);
    eventController!.enqueue({ type: "test" });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: encoder.encode(`${JSON.stringify({ type: "test" })}\n`),
    });

    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(9_999);
    let heartbeatSettled = false;
    void heartbeat.then(() => {
      heartbeatSettled = true;
    });
    await vi.runAllTicks();
    expect(heartbeatSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(heartbeat).resolves.toEqual({ done: false, value: encoder.encode("\n") });

    for (let elapsed = 20_000; elapsed < 60_000; elapsed += 10_000) {
      const nextHeartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(nextHeartbeat).resolves.toEqual({ done: false, value: encoder.encode("\n") });
    }
    const control = reader.read();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(control).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not lease a response when the client does not negotiate controls", async () => {
    vi.useFakeTimers();
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      stubSession(new ReadableStream()),
    );
    const reader = response.body!.getReader();
    await reader.read();

    let settled = false;
    const pending = reader.read().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    await reader.cancel();
    await pending;
  });

  it("cancels the durable source once a tail-indexed read reaches the tail", async () => {
    const { cancelled, source } = openByteSource(3);
    const url = "https://eve.test/eve/v1/session/session_1/stream?includeTailIndex=1";

    const response = await createSessionStreamResponse(
      new Request(url),
      stubSession(
        parseNdjsonStream(() => source),
        1,
      ),
    );

    await expect(response.text()).resolves.toBe('\n{"sequence":0}\n{"sequence":1}\n');
    await vi.waitFor(() => expect(cancelled()).toBe(true));
  });

  it("cancels the durable source when the client aborts", async () => {
    const { cancelled, source } = openByteSource(1);
    const abort = new AbortController();

    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream", { signal: abort.signal }),
      stubSession(parseNdjsonStream(() => source)),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    abort.abort();

    await vi.waitFor(() => expect(cancelled()).toBe(true));
  });

  it("cancels the durable source when the response body is cancelled", async () => {
    const { cancelled, source } = openByteSource(1);

    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      stubSession(parseNdjsonStream(() => source)),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(cancelled()).toBe(true));
  });
});
