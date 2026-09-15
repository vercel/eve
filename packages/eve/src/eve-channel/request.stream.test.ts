import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session } from "#channel/session.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionStreamResponse", () => {
  it("closes and cancels an idle live stream", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const events = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const session = {
      id: "session_1",
      async getEventStream() {
        return events;
      },
    } as Session;

    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      session,
    );
    const reader = response.body!.getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const nextRead = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(nextRead).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("resets the idle timeout after each event", async () => {
    vi.useFakeTimers();
    let eventController: ReadableStreamDefaultController<unknown> | undefined;
    const events = new ReadableStream({
      start(controller) {
        eventController = controller;
      },
    });
    const session = {
      id: "session_1",
      async getEventStream() {
        return events;
      },
    } as Session;

    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      session,
    );
    const reader = response.body!.getReader();
    await reader.read();

    await vi.advanceTimersByTimeAsync(9_000);
    eventController!.enqueue({ type: "test" });
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    let settled = false;
    const nextRead = reader.read().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(nextRead).resolves.toEqual({ done: true, value: undefined });
  });
});
