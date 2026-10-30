import { describe, expect, it } from "vitest";

import { accumulate } from "./memory.js";

const recalled = (turnId: string, overrides: { cleared?: number; scope?: string } = {}) => ({
  cleared: overrides.cleared ?? null,
  result: null,
  scope: overrides.scope ?? "alice",
  turnId,
});

describe("accumulate", () => {
  it("keeps earlier turns' recalls, and replaces what an id recalled before", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
      { content: "Asked about invoices." },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers French.", itemKey: "language" },
      { content: "Asked about refunds." },
    ]);

    expect(second.batches).toEqual([
      { messages: [{ content: "Asked about invoices." }], turnId: "turn_0" },
      {
        messages: [
          { content: "Prefers French.", id: "language" },
          { content: "Asked about refunds." },
        ],
        turnId: "turn_1",
      },
    ]);
  });

  it("leaves an id's message where it was when its content is the same", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);

    expect(second.batches).toEqual(first.batches);
  });

  it("replaces a turn's recall when that turn recalls again", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Once." }]);
    const again = accumulate(first as never, recalled("turn_0"), [{ content: "Once." }]);

    expect(again.batches).toEqual([{ messages: [{ content: "Once." }], turnId: "turn_0" }]);
  });

  it("starts over after a clear or under another scope", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Alice's note." }]);
    const cleared = accumulate(first as never, recalled("turn_1", { cleared: 7 }), [
      { content: "After the clear." },
    ]);
    const bob = accumulate(first as never, recalled("turn_1", { scope: "bob" }), [
      { content: "Bob's note." },
    ]);

    expect(cleared.batches).toEqual([
      { messages: [{ content: "After the clear." }], turnId: "turn_1" },
    ]);
    expect(bob.batches).toEqual([{ messages: [{ content: "Bob's note." }], turnId: "turn_1" }]);
  });
});
