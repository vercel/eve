import { describe, expect, it } from "vitest";

import { stampTestEvent } from "#internal/testing/events.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import { stampMessageStreamEvent, type MessageStreamEvent } from "#protocol/message.js";

function sessionStarted(index: number) {
  return stampTestEvent({ type: "session.started", data: {} }, index);
}

describe("createEventDeduper", () => {
  it("keys on the event id rather than the payload", () => {
    const deduper = createEventDeduper();
    const replayed = sessionStarted(0);

    // Re-delivering one event is a duplicate; two emissions of a
    // byte-identical payload are not.
    expect(deduper.admit(replayed)).toBe(true);
    expect(deduper.admit(replayed)).toBe(false);
    expect(deduper.admit(stampMessageStreamEvent({ type: "session.started", data: {} }))).toBe(
      true,
    );
    expect(deduper.admit(stampMessageStreamEvent({ type: "session.started", data: {} }))).toBe(
      true,
    );
    expect(deduper.size).toBe(3);
  });

  it("drops the whole replay when a long session rewinds to the start", () => {
    // Long enough that a bounded window would have evicted its own oldest ids.
    const stream = Array.from({ length: 25_000 }, (_, index) => sessionStarted(index));
    const deduper = createEventDeduper();

    const firstRead = stream.filter((event) => deduper.admit(event));
    const rewound = stream.filter((event) => deduper.admit(event));

    expect(firstRead).toHaveLength(stream.length);
    expect(rewound).toHaveLength(0);
  });

  it("admits events written before ids existed", () => {
    const deduper = createEventDeduper();
    // Stream version 19 and earlier: envelope present, but only `at`.
    const preV20 = {
      type: "session.started",
      data: {},
      meta: { at: "2026-07-27T18:04:11.912Z" },
    } as MessageStreamEvent;

    expect(deduper.admit(preV20)).toBe(true);
    expect(deduper.admit(preV20)).toBe(true);
    expect(deduper.size).toBe(0);
  });

  it("admits events with no envelope at all", () => {
    const deduper = createEventDeduper();
    const bare = { type: "session.started", data: {} } as MessageStreamEvent;

    expect(deduper.admit(bare)).toBe(true);
    expect(deduper.size).toBe(0);
  });
});
