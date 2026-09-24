import { describe, expect, it } from "vitest";

import { normalizeTaskTimeout } from "#shared/task-timeout.js";

describe("normalizeTaskTimeout", () => {
  it.each([undefined, false, 1, 2.5, 3 * 60 * 60_000])("accepts %j", (value) => {
    expect(normalizeTaskTimeout(value, "Agent config:")).toBe(value);
  });

  it.each([
    [0, "0"],
    [-1, "-1"],
    [Number.NaN, "null"],
    [Number.POSITIVE_INFINITY, "null"],
    ["2h", '"2h"'],
    [true, "true"],
    [{ ms: 1 }, '{"ms":1}'],
  ])("rejects %j with a message naming the owner and the value", (value, shown) => {
    expect(() => normalizeTaskTimeout(value, "Agent config:")).toThrow(
      `Agent config: "timeout" must be a positive number of milliseconds or false, received ${shown}.`,
    );
  });
});
