import { describe, expect, it } from "vitest";

import {
  acrossStepBoundary,
  received,
  structuredCloneBoundary,
  type StepBoundary,
} from "#execution/in-process/step-boundary.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";

// The in-process default and Workflow's serializer agree on what a step receives, so an
// in-process session's steps see what a deployment's would.
const boundaries: readonly (readonly [string, StepBoundary])[] = [
  ["a structured clone", structuredCloneBoundary],
  ["Workflow's serializer", workflowStepBoundary],
];

describe.each(boundaries)("across %s", (_name, boundary) => {
  it("hands the next step a copy, as a deployment's serializer does", async () => {
    const value = {
      at: new Date("2026-10-31T00:00:00.000Z"),
      names: ["Alice", "Bob"],
      seen: new Map([["Alice", 1]]),
      tags: new Set(["a"]),
      nothing: null,
    };
    const crossed = await acrossStepBoundary(boundary, value);
    expect(crossed).toEqual(value);
    expect(crossed).not.toBe(value);
    expect(crossed.at).toBeInstanceOf(Date);
    expect(crossed.seen).toBeInstanceOf(Map);
  });

  it("gives each receiver its own copy of what was sent once", async () => {
    const crossing = await boundary.send({ names: ["Alice"] });
    const first = await received<{ names: string[] }>(boundary, crossing);
    const second = await received<{ names: string[] }>(boundary, crossing);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("refuses what a step can't receive in a deployment", async () => {
    await expect(acrossStepBoundary(boundary, { run: () => "Alice" })).rejects.toThrow();
  });
});
