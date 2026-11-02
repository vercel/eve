import { describe, expect, it } from "vitest";

import { acrossStepBoundary } from "#execution/in-process/step-boundary.js";

describe("acrossStepBoundary", () => {
  it("hands the next step a copy, as a deployment's serializer does", async () => {
    const value = { at: new Date("2026-10-31T00:00:00.000Z"), names: ["Alice", "Bob"] };
    const crossed = await acrossStepBoundary(value);
    expect(crossed).toEqual(value);
    expect(crossed).not.toBe(value);
    expect(crossed.at).toBeInstanceOf(Date);
  });

  it("refuses what a step can't receive in a deployment", async () => {
    await expect(acrossStepBoundary({ run: () => "Alice" })).rejects.toThrow();
  });
});
