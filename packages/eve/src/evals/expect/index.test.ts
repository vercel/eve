import { describe, expect, it } from "vitest";

import { equals, includes, similarity } from "#evals/expect/index.js";

describe("expect builders", () => {
  it("includes scores 1 on substring, 0 otherwise, gate by default", () => {
    const assertion = includes("foo");
    expect(assertion.severity).toBe("gate");
    expect(assertion.score("a foo b")).toBe(1);
    expect(assertion.score("bar")).toBe(0);
    expect(assertion.score(undefined)).toBe(0);
  });

  it("equals deep-compares structurally, gate by default", () => {
    const assertion = equals({ a: 1, b: [2, 3] });
    expect(assertion.severity).toBe("gate");
    expect(assertion.score({ a: 1, b: [2, 3] })).toBe(1);
    expect(assertion.score({ a: 1, b: [2, 4] })).toBe(0);
    expect(assertion.score({ a: 1 })).toBe(0);
  });

  it("similarity is soft by default and scores 1 on an exact match", async () => {
    const assertion = similarity("hello");
    expect(assertion.severity).toBe("soft");
    expect(assertion.threshold).toBeUndefined();
    expect(await assertion.score("hello")).toBe(1);
  });

  it("chaining overrides severity and threshold without mutating the original", () => {
    const base = includes("x");

    const soft = base.soft();
    expect(soft.severity).toBe("soft");
    expect(soft.threshold).toBeUndefined();

    const gated = base.atLeast(0.6);
    expect(gated.severity).toBe("soft");
    expect(gated.threshold).toBe(0.6);

    const hard = similarity("x").gate(0.8);
    expect(hard.severity).toBe("gate");
    expect(hard.threshold).toBe(0.8);

    // original is unchanged
    expect(base.severity).toBe("gate");
  });
});
