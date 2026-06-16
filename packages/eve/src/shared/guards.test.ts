import { describe, expect, it } from "vitest";

import { isNonEmptyString, isObject, isPlainRecord, isThenable } from "#shared/guards.js";

describe("isObject", () => {
  it("accepts plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(Object.create(null))).toBe(true);
  });

  it("rejects null, primitives, and arrays", () => {
    expect(isObject(null)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject("s")).toBe(false);
    expect(isObject(0)).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2])).toBe(false);
  });

  it("accepts class instances and Error objects", () => {
    expect(isObject(new Error("boom"))).toBe(true);
    expect(isObject(new Map())).toBe(true);
  });
});

describe("isThenable", () => {
  it("accepts objects with a then function", () => {
    expect(isThenable(Promise.resolve(1))).toBe(true);
    // eslint-disable-next-line unicorn/no-thenable -- exercising isThenable against a hand-rolled thenable
    expect(isThenable({ then: () => undefined })).toBe(true);
  });

  it("rejects non-thenables", () => {
    expect(isThenable(null)).toBe(false);
    expect(isThenable({})).toBe(false);
    expect(isThenable("then")).toBe(false);
  });
});

describe("isPlainRecord", () => {
  it("accepts plain objects", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it("rejects null, primitives, arrays, and class instances", () => {
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new Error("boom"))).toBe(false);
    expect(isPlainRecord(new Map())).toBe(false);
  });
});

describe("isNonEmptyString", () => {
  it("accepts strings with at least one character", () => {
    expect(isNonEmptyString("a")).toBe(true);
    expect(isNonEmptyString(" ")).toBe(true);
    expect(isNonEmptyString("multi word")).toBe(true);
  });

  it("rejects empty strings, non-strings, and nullish values", () => {
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
    expect(isNonEmptyString(["a"])).toBe(false);
  });
});
