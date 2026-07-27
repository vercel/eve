import { describe, expect, it } from "vitest";

import { stampTestEvent } from "#internal/testing/events.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import {
  stampMessageStreamEvent,
  type StampedHandleMessageStreamEvent,
} from "#protocol/message.js";

function sessionStarted(index: number) {
  return stampTestEvent({ type: "session.started", data: {} }, index);
}

describe("createEventDeduper", () => {
  it("keys on the event id rather than the payload", () => {
    const deduper = createEventDeduper();
    const replayed = sessionStarted(0);

    // Re-delivering one event is a duplicate; two emissions of a
    // byte-identical payload are not.
    expect(deduper.isDuplicate(replayed)).toBe(false);
    expect(deduper.isDuplicate(replayed)).toBe(true);
    expect(
      deduper.isDuplicate(stampMessageStreamEvent({ type: "session.started", data: {} })),
    ).toBe(false);
    expect(
      deduper.isDuplicate(stampMessageStreamEvent({ type: "session.started", data: {} })),
    ).toBe(false);
    expect(deduper.size).toBe(3);
  });

  it("drops the whole replay when a long session rewinds to the start", () => {
    // A bounded window would have evicted the oldest ids by now, and
    // re-admitting the first event would cascade the entire stream back in.
    const stream = Array.from({ length: 25_000 }, (_, index) => sessionStarted(index));
    const deduper = createEventDeduper();

    expect(stream.filter((event) => !deduper.isDuplicate(event))).toHaveLength(stream.length);
    expect(stream.filter((event) => !deduper.isDuplicate(event))).toHaveLength(0);
  });

  it("admits events written before ids existed", () => {
    const deduper = createEventDeduper();
    // Stream version 19 and earlier: the envelope is present, but carries
    // only `at`.
    const preV20 = {
      type: "session.started",
      data: {},
      meta: { at: "2026-07-27T18:04:11.912Z" },
    } as StampedHandleMessageStreamEvent;

    expect(deduper.isDuplicate(preV20)).toBe(false);
    expect(deduper.isDuplicate(preV20)).toBe(false);
    expect(deduper.size).toBe(0);
  });

  it("admits events with no envelope at all", () => {
    const deduper = createEventDeduper();
    const bare = { type: "session.started", data: {} } as StampedHandleMessageStreamEvent;

    expect(deduper.isDuplicate(bare)).toBe(false);
    expect(deduper.size).toBe(0);
  });
});
