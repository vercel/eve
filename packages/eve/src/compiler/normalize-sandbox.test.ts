import { describe, expect, it } from "vitest";

import { resolveParentSandboxSelector } from "#compiler/normalize-sandbox.js";

describe("resolveParentSandboxSelector", () => {
  it("recognizes a callback that returns parent.sandbox", async () => {
    const selector = ({ parent }: { parent: { sandbox: unknown } }) => parent.sandbox;

    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("rejects callbacks that return anything else", async () => {
    await expect(
      resolveParentSandboxSelector((_context: unknown) => ({ nope: true }), "invalid sandbox"),
    ).rejects.toThrow(
      "The sandbox callback form is only for parent sharing. Return parent.sandbox, or export a sandbox definition object to configure an independent sandbox.",
    );
  });

  it("distinguishes an authored callback error from the sharing requirement", async () => {
    await expect(
      resolveParentSandboxSelector(() => {
        throw new Error("authored failure");
      }, "invalid sandbox"),
    ).rejects.toThrow(
      "export a sandbox definition object to configure an independent sandbox. The callback threw: authored failure",
    );
  });

  it("leaves object definitions unchanged", async () => {
    await expect(resolveParentSandboxSelector({}, "invalid sandbox")).resolves.toBe(false);
  });
});
