import { describe, expect, it } from "vitest";

import { defineHarness } from "#public/definitions/harness.js";
import { changesStage, runStage, stackOf } from "./stack.js";

const ctx = {};

describe("defineHarness", () => {
  it("flattens harnesses and layers into one stack, outermost first", () => {
    const inner = defineHarness({ instructions: "inner" });
    const harness = defineHarness([{ instructions: "outer" }, inner]);
    expect(harness.layers.map((layer) => layer.instructions)).toEqual(["outer", "inner"]);
  });

  it("refuses a stage it doesn't know", () => {
    expect(() => defineHarness({ admitt: () => "join" } as never)).toThrow(/no "admitt" stage/);
  });

  it("puts a naked layer last, and makes it decide every turn", () => {
    expect(() => defineHarness([{ extends: false, next: () => ({ settle: "" }) }, {}])).toThrow(
      /must be the last layer/,
    );
    expect(() => defineHarness({ extends: false })).toThrow(/define `next`/);
  });
});

describe("stackOf", () => {
  it("stops at a naked layer: the extensions after it don't join", () => {
    const stack = stackOf([
      { harness: defineHarness({ extends: false, next: () => ({ settle: "" }) }), label: "agent" },
      { harness: defineHarness({ instructions: "ext" }), label: "ext", namespace: "ext" },
    ]);
    expect(stack.naked).toBe(true);
    expect(stack.layers.map((layer) => layer.label)).toEqual(["agent"]);
    expect(changesStage(stack, "history")).toBe(true);
  });
});

describe("runStage", () => {
  it("runs each layer's stage over the one below, with eve's at the bottom", async () => {
    const order: string[] = [];
    const stack = stackOf([
      {
        harness: defineHarness({
          history: async (_ctx, below) => {
            order.push("agent");
            return [...(await below()), { content: "agent", role: "assistant" }];
          },
        }),
        label: "agent",
      },
      {
        harness: defineHarness({
          history: async (_ctx, below) => {
            order.push("ext");
            return [...(await below()), { content: "ext", role: "assistant" }];
          },
        }),
        label: "ext",
      },
    ]);
    const messages = await runStage(stack, "history", ctx, async () => {
      order.push("eve");
      return [{ content: "eve", role: "assistant" as const }];
    });
    expect(order).toEqual(["agent", "ext", "eve"]);
    expect(messages.map((message) => message.content)).toEqual(["eve", "ext", "agent"]);
  });

  it("runs nothing below a layer that doesn't call below()", async () => {
    let ranEve = false;
    const stack = stackOf([
      { harness: defineHarness({ next: () => ({ settle: "mine" }) }), label: "agent" },
    ]);
    const action = await runStage(stack, "next", ctx, async () => {
      ranEve = true;
      return { model: {} };
    });
    expect(action).toEqual({ settle: "mine" });
    expect(ranEve).toBe(false);
  });

  it("makes below() once, however often a layer calls it", async () => {
    let made = 0;
    const stack = stackOf([
      {
        harness: defineHarness({
          next: async (_ctx, below) => {
            await below();
            return await below();
          },
        }),
        label: "agent",
      },
    ]);
    await runStage(stack, "next", ctx, async () => {
      made += 1;
      return { model: {} };
    });
    expect(made).toBe(1);
  });
});
