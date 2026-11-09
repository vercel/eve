import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { sessions } from "#public/server/index.js";

const getRunMock = vi.fn();
const getRunMetadataMock = vi.fn();
vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  getWorld: async () => ({ runs: { get: getRunMetadataMock } }),
}));

const encoder = new TextEncoder();

function storedLines(count: number): StoredLine[] {
  return Array.from({ length: count }, (_, index) => ({
    at: "2026-10-15T00:00:00.000Z",
    facts:
      index === 0
        ? [
            {
              type: "session.started",
              data: { runtime: { agentId: "reader", agentName: "reader", eveVersion: "test" } },
            },
          ]
        : [
            {
              type: "delivery.admitted",
              data: { deliveryId: `delivery_${index}`, source: { channel: "http" } },
            },
          ],
  }));
}

function mockSessionStream(stored: readonly StoredLine[], options: { open?: boolean } = {}) {
  const startIndexes: Array<number | undefined> = [];
  const cancelled: Array<number | undefined> = [];
  getRunMock.mockImplementation(() => ({
    getReadable(readOptions?: { startIndex?: number }) {
      const startIndex = readOptions?.startIndex;
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          if (startIndex === undefined) return;
          startIndexes.push(startIndex);
          for (const line of stored.slice(startIndex)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
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

async function collect(iterable: AsyncIterable<SessionStreamEvent>) {
  const events: SessionStreamEvent[] = [];
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
  it("rejects expired history even when stored chunks remain", async () => {
    const stream = mockSessionStream(storedLines(2));
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
  });

  it("keeps history readable until its retention deadline", async () => {
    mockSessionStream(storedLines(2));
    getRunMetadataMock.mockResolvedValue({
      status: "completed",
      expiredAt: new Date("2100-01-01T00:00:00.000Z"),
    });

    const events = await collect(sessions.attach("wrun_1").stream({ follow: false }));
    expect(events.map((event) => event.type)).toEqual(["session.started", "delivery.admitted"]);
  });

  it("ends a bounded read at the observed tail, even while the underlying stream stays open", async () => {
    const stream = mockSessionStream(storedLines(3), { open: true });
    const events = await collect(
      sessions.attach("wrun_1").stream({ startIndex: 1, follow: false }),
    );

    expect(events.map((event) => event.meta.position.line)).toEqual([1, 2]);
    expect(stream.startIndexes).toEqual([1]);
    expect(stream.cancelled).toContain(1);
  });

  it("resolves a tail-relative start against stored line positions", async () => {
    const stream = mockSessionStream(storedLines(5));
    const events = await collect(sessions.attach("wrun_1").stream({ startIndex: -2 }));

    expect(events.map((event) => event.meta.position.line)).toEqual([3, 4]);
    expect(stream.startIndexes).toEqual([3]);
  });

  it("does not open a bounded read beyond the tail", async () => {
    const stream = mockSessionStream(storedLines(2));
    await expect(
      collect(sessions.attach("wrun_1").stream({ startIndex: 2, follow: false })),
    ).resolves.toEqual([]);
    expect(stream.startIndexes).toEqual([]);
  });

  it("cancels a following read when its signal aborts", async () => {
    const stream = mockSessionStream(storedLines(2), { open: true });
    const abort = new AbortController();
    const events: SessionStreamEvent[] = [];
    for await (const event of sessions.attach("wrun_1").stream({ signal: abort.signal })) {
      events.push(event);
      if (events.length === 2) abort.abort();
    }
    expect(events.map((event) => event.meta.position.line)).toEqual([0, 1]);
    expect(stream.cancelled).toContain(0);
  });
});
