import { describe, expect, it } from "vitest";

import { parseJsonObject, parseJsonValue } from "#shared/json.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";

describe("parseJsonValue", () => {
  it("preserves JSON primitives", () => {
    expect(parseJsonValue("hello")).toBe("hello");
    expect(parseJsonValue(42)).toBe(42);
    expect(parseJsonValue(false)).toBe(false);
    expect(parseJsonValue(null)).toBeNull();
  });

  it("omits undefined object properties recursively", () => {
    expect(
      parseJsonValue({
        filters: {
          city: "Brooklyn",
          cursor: undefined,
        },
        pagination: {
          next: undefined,
          previous: null,
        },
        limit: undefined,
      }),
    ).toEqual({
      filters: {
        city: "Brooklyn",
      },
      pagination: {
        previous: null,
      },
    });
  });

  it("preserves null-prototype objects", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.city = "Brooklyn";
    value.cursor = undefined;

    expect(parseJsonValue(value)).toEqual({
      city: "Brooklyn",
    });
  });

  it("rejects arrays with undefined entries", () => {
    expect(() => parseJsonValue(["brooklyn", undefined])).toThrow(
      "Expected a JSON-serializable value.",
    );
  });

  it("rejects cyclic objects", () => {
    const value: Record<string, unknown> = {
      city: "Brooklyn",
    };
    value.self = value;

    expect(() => parseJsonValue(value)).toThrow("Expected a JSON-serializable value.");
  });

  it("rejects non-finite numbers", () => {
    expect(() => parseJsonValue(Number.NaN)).toThrow("Expected a JSON-serializable value.");
    expect(() => parseJsonValue(Number.POSITIVE_INFINITY)).toThrow(
      "Expected a JSON-serializable value.",
    );
  });

  it("rejects lossy built-in object instances", () => {
    expect(() => parseJsonValue(new Date())).toThrow("Expected a JSON-serializable value.");
    expect(() => parseJsonValue(new Map([["city", "Brooklyn"]]))).toThrow(
      "Expected a JSON-serializable value.",
    );
    expect(() => parseJsonValue(new Set(["Brooklyn"]))).toThrow(
      "Expected a JSON-serializable value.",
    );
  });

  it("rejects non-JSON scalars", () => {
    expect(() => parseJsonValue(undefined)).toThrow("Expected a JSON-serializable value.");
    expect(() => parseJsonValue(1n)).toThrow("Expected a JSON-serializable value.");
    expect(() => parseJsonValue(Symbol.for("city"))).toThrow("Expected a JSON-serializable value.");
    expect(() => parseJsonValue(() => "Brooklyn")).toThrow("Expected a JSON-serializable value.");
  });
});

describe("parseJsonObject", () => {
  it("omits undefined object properties while preserving defined values", () => {
    expect(
      parseJsonObject({
        filters: {
          city: "Brooklyn",
          cursor: undefined,
        },
        limit: undefined,
      }),
    ).toEqual({
      filters: {
        city: "Brooklyn",
      },
    });
  });

  it("rejects top-level arrays and primitives", () => {
    expect(() => parseJsonObject(["brooklyn"])).toThrow("Expected a JSON-serializable object.");
    expect(() => parseJsonObject(null)).toThrow("Expected a JSON-serializable object.");
    expect(() => parseJsonObject("brooklyn")).toThrow("Expected a JSON-serializable object.");
  });
});

describe("jsonObjectSchema", () => {
  it("normalizes object input through zod callers", () => {
    expect(
      jsonObjectSchema.parse({
        filters: {
          city: "Brooklyn",
          cursor: undefined,
        },
      }),
    ).toEqual({
      filters: {
        city: "Brooklyn",
      },
    });
  });
});

describe("jsonValueSchema", () => {
  it("normalizes nested object values through zod callers", () => {
    expect(
      jsonValueSchema.parse({
        rows: [{ city: "Brooklyn", cursor: undefined }],
      }),
    ).toEqual({
      rows: [{ city: "Brooklyn" }],
    });
  });

  it("rejects non-plain object instances", () => {
    expect(jsonValueSchema.safeParse(new Date()).success).toBe(false);
  });

  it("rejects arrays with undefined entries", () => {
    expect(jsonValueSchema.safeParse(["brooklyn", undefined]).success).toBe(false);
  });
});
