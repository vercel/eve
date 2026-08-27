import { describe, expect, it, vi } from "vitest";

import { openRunControlInbox } from "#execution/tool-run/run-control.js";

const messages: unknown[] = [];

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: () => ({
    token: "run-hook",
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const value = messages.shift();
          return value === undefined
            ? await new Promise<IteratorResult<unknown>>(() => {})
            : { done: false, value };
        },
      };
    },
  }),
  defineHook: () => ({ create: vi.fn() }),
}));

describe("run control inbox", () => {
  it("observes release without aborting the run", async () => {
    messages.push({ kind: "release" });
    const control = openRunControlInbox("run-hook");

    await control.released;

    expect(control.signal.aborted).toBe(false);
  });
});
