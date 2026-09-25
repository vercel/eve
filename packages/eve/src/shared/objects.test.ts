import { describe, expect, it } from "vitest";

import { mergeObjects } from "#shared/objects.js";

describe("mergeObjects", () => {
  it("recursively merges disjoint keys and lets overrides win conflicts", () => {
    const base = {
      a: {
        b: 1,
        nested: { base: true, shared: "base" },
        shared: "base",
      },
    };
    const overrides = {
      a: {
        c: 1,
        nested: { override: true, shared: "override" },
        shared: "override",
      },
    };

    expect(mergeObjects(base, overrides)).toEqual({
      a: {
        b: 1,
        c: 1,
        nested: { base: true, override: true, shared: "override" },
        shared: "override",
      },
    });
    expect(base).toEqual({
      a: {
        b: 1,
        nested: { base: true, shared: "base" },
        shared: "base",
      },
    });
    expect(overrides).toEqual({
      a: {
        c: 1,
        nested: { override: true, shared: "override" },
        shared: "override",
      },
    });
  });

  it("replaces arrays, primitives, nullish values, and exotic objects", () => {
    const date = new Date("2026-08-25T00:00:00.000Z");
    const map = new Map([["authored", true]]);
    const result = mergeObjects(
      {
        array: [1],
        date: { default: true },
        map: { default: true },
        nullish: { default: true },
        primitive: "default",
        undefinedValue: { default: true },
      },
      {
        array: [2],
        date,
        map,
        nullish: null,
        primitive: 42,
        undefinedValue: undefined,
      },
    );

    expect(result).toEqual({
      array: [2],
      date,
      map,
      nullish: null,
      primitive: 42,
      undefinedValue: undefined,
    });
    expect(result.date).toBe(date);
    expect(result.map).toBe(map);
  });

  it("merges __proto__ as data without polluting object prototypes", () => {
    const base = JSON.parse('{"__proto__":{"base":true}}') as Record<string, unknown>;
    const overrides = JSON.parse('{"__proto__":{"override":true}}') as Record<string, unknown>;
    const result = mergeObjects(base, overrides);

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ base: true, override: true });
    expect(Object.hasOwn(Object.prototype, "base")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "override")).toBe(false);
  });
});
