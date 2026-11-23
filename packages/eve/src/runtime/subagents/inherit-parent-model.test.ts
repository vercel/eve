import { describe, expect, it, vi } from "vitest";

import { inheritParentModel, inheritsParentModel } from "#runtime/subagents/inherit-parent-model.js";

describe("inheritParentModel", () => {
  it("marks a definition so a separate copy of the module recognises it", async () => {
    const definition = inheritParentModel({ description: "Edits the agent." });
    vi.resetModules();
    const otherCopy = await import("#runtime/subagents/inherit-parent-model.js");

    expect(otherCopy.inheritsParentModel).not.toBe(inheritsParentModel);
    expect(otherCopy.inheritsParentModel(definition)).toBe(true);
  });

  it("does not mark a definition nothing marked", () => {
    expect(inheritsParentModel({ description: "Edits the agent." })).toBe(false);
  });
});
