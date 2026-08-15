import { describe, expect, it } from "vitest";

import { err, ok, type Result } from "#shared/result.js";

describe("Result", () => {
  it("constructs a success", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("constructs a failure", () => {
    expect(err("nope")).toEqual({ ok: false, error: "nope" });
  });

  it("narrows by the ok discriminant", () => {
    function parseNumber(value: number): Result<number, "nan"> {
      return Number.isNaN(value) ? err("nan") : ok(value);
    }

    const result = parseNumber(1);
    expect(result.ok ? result.value : result.error).toBe(1);
  });
});
