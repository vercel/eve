import { describe, expect, it } from "vitest";
import { defineParentSandbox } from "#public/definitions/sandbox.js";
import { createRuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
const parent: ResolvedSandboxDefinition = {
  kind: "parent",
  logicalPath: "sandbox.ts",
  revisionHash: "parent-sandbox-revision",
  selector: defineParentSandbox(),
  sourceId: "sandbox",
  sourceKind: "module",
};
describe("createRuntimeSandboxRegistry", () => {
  it("allows parent inheritance without resources", () => {
    expect(
      createRuntimeSandboxRegistry({
        sandbox: parent,
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }).sandbox.definition.kind,
    ).toBe("parent");
  });
  it("rejects parent inheritance with resources", () => {
    expect(() =>
      createRuntimeSandboxRegistry({
        sandbox: parent,
        workspaceResourceRoot: { contentHash: "hash", logicalPath: "resources", rootEntries: [] },
      }),
    ).toThrow("managed workspace resources");
  });
});
