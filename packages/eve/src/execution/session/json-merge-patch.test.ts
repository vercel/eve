import { describe, expect, it } from "vitest";

import { mergePatch } from "#execution/session/json-merge-patch.js";
import type { JsonObject } from "#shared/json.js";

describe("mergePatch", () => {
  // RFC 7386 Appendix A, minus the cases whose patch is not an object: a channel-state patch
  // always is.
  const examples: ReadonlyArray<readonly [Record<string, unknown>, JsonObject, unknown]> = [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  it.each(examples)("applies RFC 7386 example %j + %j", (target, patch, expected) => {
    expect(mergePatch(target, patch)).toEqual(expected);
  });

  it("merges nested objects key by key", () => {
    const target = { prompts: { s_a: { url: "a", seen: true }, s_b: { url: "b" } } };
    expect(mergePatch(target, { prompts: { s_a: { url: "a2" }, s_c: { url: "c" } } })).toEqual({
      prompts: { s_a: { url: "a2", seen: true }, s_b: { url: "b" }, s_c: { url: "c" } },
    });
  });

  it("replaces a scalar with an object, and an object with a scalar", () => {
    expect(mergePatch({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(mergePatch({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });

  it("leaves the target unchanged", () => {
    const target = { a: { b: "c" } };
    mergePatch(target, { a: { b: null } });
    expect(target).toEqual({ a: { b: "c" } });
  });
});
