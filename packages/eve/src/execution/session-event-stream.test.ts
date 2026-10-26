import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { TEST_USAGE, stampTestEvent } from "#internal/testing/events.js";
import { createSessionWaitingEvent, type MessageStreamEvent } from "#protocol/message.js";
import { sessions } from "#public/server/index.js";

const getRunMock = vi.fn();
const getRunMetadataMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  getWorld: async () => ({ runs: { get: getRunMetadataMock } }),
}));

const encoder = new TextEncoder();

/**
 * Mocks one session's durable stream holding `stored` events. With
 * `open: true`, reads never reach EOF, like a live session.
 */
function mockSessionStream(
  stored: readonly MessageStreamEvent[],
  options: { open?: boolean } = {},
) {
  const startIndexes: Array<number | undefined> = [];
  const cancelled: Array<number | undefined> = [];
  getRunMock.mockImplementation(() => ({
    getReadable(readOptions?: { startIndex?: number }) {
      const startIndex = readOptions?.startIndex;
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          if (startIndex === undefined) return;
          startIndexes.push(startIndex);
          for (const event of stored.slice(startIndex)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          if (!options.open) controller.close();
        },
        cancel() {
          cancelled.push(startIndex);
        },
      });
      return Object.assign(readable, { getTailIndex: async () => stored.length - 1 });
    },
  }));
  return { cancelled, startIndexes };
}

const storedEvents = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    stampTestEvent(createSessionWaitingEvent(TEST_USAGE), index),
  );

async function collect(iterable: AsyncIterable<MessageStreamEvent>) {
  const events: MessageStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

beforeEach(() => {
  getRunMetadataMock.mockResolvedValue({ status: "running" });
});

afterEach(() => {
  getRunMock.mockReset();
  getRunMetadataMock.mockReset();
});

describe("sessions.attach().stream()", () => {
  it("rejects expired run data even when the World still reports stored stream chunks", async () => {
    const stream = mockSessionStream(storedEvents(2));
    const expiredAt = new Date("2020-01-01T00:00:00.000Z");
    getRunMetadataMock.mockResolvedValue({ status: "completed", expiredAt });

    const read = collect(sessions.attach("wrun_1").stream({ follow: false }));
    await expect(read).rejects.toBeInstanceOf(RunExpiredError);
    await expect(read).rejects.toMatchObject({
      runId: "wrun_1",
      runStatus: "completed",
      expiredAt,
    });
    expect(stream.startIndexes).toEqual([]);
    expect(getRunMetadataMock).toHaveBeenCalledWith("wrun_1", { resolveData: "none" });
  });

  it("keeps completed history readable until its retention deadline", async () => {
    const stored = storedEvents(2);
    mockSessionStream(stored);
    getRunMetadataMock.mockResolvedValue({
      status: "completed",
      expiredAt: new Date("2100-01-01T00:00:00.000Z"),
    });

    await expect(collect(sessions.attach("wrun_1").stream({ follow: false }))).resolves.toEqual(
      stored,
    );
  });

  it("ends a bounded read at the tail observed when it opens", async () => {
    const stored = storedEvents(3);
    const stream = mockSessionStream(stored, { open: true });

    const events = await collect(
      sessions.attach("wrun_1").stream({ startIndex: 1, follow: false }),
    );

    expect(getRunMock).toHaveBeenCalledWith("wrun_1");
    expect(events.map((event) => event.meta.id)).toEqual([stored[1]!.meta.id, stored[2]!.meta.id]);
    expect(stream.startIndexes).toEqual([1]);
    expect(stream.cancelled).toContain(1);
  });

  it("resolves a tail-relative start against the tail", async () => {
    const stored = storedEvents(5);
    const stream = mockSessionStream(stored);

    const events = await collect(sessions.attach("wrun_1").stream({ startIndex: -2 }));

    expect(events.map((event) => event.meta.id)).toEqual([stored[3]!.meta.id, stored[4]!.meta.id]);
    expect(stream.startIndexes).toEqual([3]);
  });

  it("returns immediately when a bounded read starts past the tail", async () => {
    const stream = mockSessionStream(storedEvents(2));

    await expect(
      collect(sessions.attach("wrun_1").stream({ startIndex: 2, follow: false })),
    ).resolves.toEqual([]);
    expect(stream.startIndexes).toEqual([]);
  });

  it("stops a following read when its signal aborts", async () => {
    const stored = storedEvents(2);
    const stream = mockSessionStream(stored, { open: true });
    const abort = new AbortController();
    const events: MessageStreamEvent[] = [];

    for await (const event of sessions.attach("wrun_1").stream({ signal: abort.signal })) {
      events.push(event);
      if (events.length === 2) abort.abort();
    }

    expect(events.map((event) => event.meta.id)).toEqual(stored.map((event) => event.meta.id));
    expect(stream.cancelled).toContain(0);
  });
});
