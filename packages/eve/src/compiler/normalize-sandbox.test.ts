import { describe, expect, it } from "vitest";

import { resolveParentSandboxSelector } from "#compiler/normalize-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";

describe("resolveParentSandboxSelector", () => {
  it("recognizes a callback that returns parent.sandbox", async () => {
    const selector = ({ parent }: { parent: { sandbox: unknown } }) => parent.sandbox;

    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("supports marked rest-parameter callbacks without relying on function arity", async () => {
    const selector = defineSandbox((...args) => {
      if (args[0].parent === null) throw new Error("parent required");
      return args[0].parent.sandbox;
    });

    expect(selector.length).toBe(0);
    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("rejects callbacks that return anything else", async () => {
    await expect(
      resolveParentSandboxSelector((_context: unknown) => ({ nope: true }), "invalid sandbox"),
    ).rejects.toThrow(
      "The callback passed to defineSandbox(...) must return parent.sandbox. Export a sandbox definition object for an independent sandbox.",
    );
  });

  it("reports authored callback errors", async () => {
    await expect(
      resolveParentSandboxSelector(() => {
        throw new Error("authored failure");
      }, "invalid sandbox"),
    ).rejects.toThrow(
      "The callback passed to defineSandbox(...) threw while selecting parent.sandbox: authored failure",
    );
  });

  it("leaves object definitions unchanged", async () => {
    await expect(resolveParentSandboxSelector({}, "invalid sandbox")).resolves.toBe(false);
  });
});
