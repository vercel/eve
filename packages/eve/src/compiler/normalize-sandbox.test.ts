import { describe, expect, it } from "vitest";

import { resolveParentSandboxSelector } from "#compiler/normalize-sandbox.js";

describe("resolveParentSandboxSelector", () => {
  it("recognizes a callback that returns parent.sandbox", async () => {
    const selector = ({ parent }: { parent: { sandbox: unknown } }) => parent.sandbox;

    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("rejects callbacks that return anything else", async () => {
    await expect(
      resolveParentSandboxSelector(() => ({ nope: true }), "invalid sandbox"),
    ).rejects.toThrow("The sandbox callback must return parent.sandbox");
  });

  it("leaves object definitions unchanged", async () => {
    await expect(resolveParentSandboxSelector({}, "invalid sandbox")).resolves.toBe(false);
  });
});
