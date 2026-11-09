import { describe, expect, it } from "vitest";

import { startEach, toolConcurrency } from "./tool-concurrency.js";

describe("tool concurrency", () => {
  it("runs tool calls in parallel where AsyncLocalStorage keeps each call's context", async () => {
    expect(toolConcurrency()).toBe("parallel");
    const order: string[] = [];
    const runs = startEach(["a", "b"], async (item) => {
      order.push(`start ${item}`);
      await Promise.resolve();
      order.push(`end ${item}`);
      return item;
    });
    expect(await Promise.all(runs)).toEqual(["a", "b"]);
    expect(order).toEqual(["start a", "start b", "end a", "end b"]);
  });
});
