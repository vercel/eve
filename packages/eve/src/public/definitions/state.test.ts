import { describe, expect, it } from "vitest";

import { defineState } from "#public/definitions/state.js";
import { ContextContainer, contextStorage } from "#context/container.js";

function runInContext<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

describe("defineState", () => {
  it("get() throws outside ALS", () => {
    const counter = defineState("test.get.throws", () => ({ count: 0 }));

    expect(() => counter.get()).toThrow(/No active eve context/);
  });

  it("rejects names using the reserved eve. prefix", () => {
    // Authoring `defineState("eve.channel", ...)` would otherwise register a
    // codec-less key over the framework's codec-carrying internal key and
    // silently corrupt context serialization.
    expect(() => defineState("eve.channel", () => null)).toThrow(/reserved/);
    expect(() => defineState("eve.budget", () => ({ count: 0 }))).toThrow(/reserved/);
  });

  it("get() returns initial() on first read inside ALS", () => {
    const counter = defineState("test.get.initial", () => ({ count: 0 }));

    runInContext(() => {
      expect(counter.get()).toEqual({ count: 0 });
    });
  });

  it("update() applies a function to the current value", () => {
    const counter = defineState("test.update.apply", () => ({ count: 0 }));

    runInContext(() => {
      counter.update((s) => ({ count: s.count + 1 }));
      counter.update((s) => ({ count: s.count + 1 }));
      expect(counter.get()).toEqual({ count: 2 });
    });
  });

  it("update() throws outside ALS", () => {
    const counter = defineState("test.update.throws", () => ({ count: 0 }));

    expect(() => counter.update((s) => ({ count: s.count + 1 }))).toThrow(/No active eve context/);
  });

  it("separate handles with different names are independent", () => {
    const a = defineState("test.independent.a2", () => ({ value: "a" }));
    const b = defineState("test.independent.b2", () => ({ value: "b" }));

    runInContext(() => {
      a.update(() => ({ value: "aa" }));
      expect(a.get()).toEqual({ value: "aa" });
      expect(b.get()).toEqual({ value: "b" });
    });
  });
});
