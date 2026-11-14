import { describe, expect, it } from "vitest";

import { demoSchema } from "./ground-truth.js";

describe(demoSchema, () => {
  it.each([
    [["warehouse", "analytics"], "analytics"],
    [["analytics"], "analytics"],
    [["demo"], "demo"],
    [[], "analytics"],
  ])("picks the demo schema from %j", (schemas, expected) => {
    expect(demoSchema(schemas)).toBe(expected);
  });
});
