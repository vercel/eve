import { describe, expect, it } from "vitest";

import { InMemoryLoopEventLog, type LoopEventPublication } from "#internal/loops/event-log.js";
import {
  createSessionCompletedEvent,
  createSessionWaitingEvent,
  timestampHandleMessageStreamEvent,
  type TimedHandleMessageStreamEvent,
} from "#protocol/message.js";

const encoder = new TextEncoder();

function publication(input: {
  readonly at: string;
  readonly key: string;
  readonly type: "session.completed" | "session.waiting";
}): LoopEventPublication {
  const event = timestampHandleMessageStreamEvent(
    input.type === "session.completed"
      ? createSessionCompletedEvent()
      : createSessionWaitingEvent("http:test"),
    input.at,
  );
  return {
    encoded: encoder.encode(`${JSON.stringify(event)}\n`),
    event,
    publicationKey: input.key,
  };
}

async function readAll(
  stream: ReadableStream<TimedHandleMessageStreamEvent>,
): Promise<readonly TimedHandleMessageStreamEvent[]> {
  const events: TimedHandleMessageStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("InMemoryLoopEventLog", () => {
  it("replays existing events and then follows live appends", async () => {
    const log = new InMemoryLoopEventLog();
    const started = publication({
      at: "2026-07-10T10:00:00.000Z",
      key: "session-1:0",
      type: "session.completed",
    });
    const waiting = publication({
      at: "2026-07-10T10:00:01.000Z",
      key: "session-1:1",
      type: "session.waiting",
    });
    expect(log.append(started)).toEqual({ kind: "inserted", streamOrdinal: 0 });

    const eventsPromise = readAll(log.stream());
    expect(log.append(waiting)).toEqual({ kind: "inserted", streamOrdinal: 1 });
    log.close();

    await expect(eventsPromise).resolves.toEqual([started.event, waiting.event]);
  });

  it("emits each live append once when pull reenters during enqueue", async () => {
    const log = new InMemoryLoopEventLog();
    const started = publication({
      at: "2026-07-10T10:00:00.000Z",
      key: "session-live:0",
      type: "session.completed",
    });
    const waiting = publication({
      at: "2026-07-10T10:00:01.000Z",
      key: "session-live:1",
      type: "session.waiting",
    });
    const eventsPromise = readAll(log.stream());
    await Promise.resolve();

    log.append(started);
    await Promise.resolve();
    log.append(waiting);
    log.close();

    await expect(eventsPromise).resolves.toEqual([started.event, waiting.event]);
  });

  it("resumes at a zero-based stream index", async () => {
    const log = new InMemoryLoopEventLog();
    const started = publication({
      at: "2026-07-10T10:00:00.000Z",
      key: "session-1:0",
      type: "session.completed",
    });
    const waiting = publication({
      at: "2026-07-10T10:00:01.000Z",
      key: "session-1:1",
      type: "session.waiting",
    });
    log.append(started);
    log.append(waiting);
    log.close();

    await expect(readAll(log.stream(1))).resolves.toEqual([waiting.event]);
  });

  it("deduplicates identical publications and rejects conflicting retries", () => {
    const log = new InMemoryLoopEventLog();
    const original = publication({
      at: "2026-07-10T10:00:00.000Z",
      key: "session-1:0",
      type: "session.completed",
    });
    expect(log.append(original)).toEqual({ kind: "inserted", streamOrdinal: 0 });
    expect(log.append(original)).toEqual({ kind: "duplicate", streamOrdinal: 0 });

    const conflicting = publication({
      at: "2026-07-10T10:00:02.000Z",
      key: "session-1:0",
      type: "session.completed",
    });
    expect(() => log.append(conflicting)).toThrow("replayed with different bytes");
  });

  it("propagates terminal failures to active readers", async () => {
    const log = new InMemoryLoopEventLog();
    const events = readAll(log.stream());
    const failure = new Error("inline turn failed");

    log.fail(failure);

    await expect(events).rejects.toBe(failure);
  });
});
