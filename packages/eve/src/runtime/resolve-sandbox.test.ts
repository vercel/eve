import { describe, expect, it } from "vitest";

import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import { resolveSandboxDefinition } from "#runtime/resolve-sandbox.js";

const inheritedSandbox: CompiledSandboxDefinition = {
  inheritsParent: true,
  logicalPath: "sandbox.ts",
  revisionHash: "parent-source-hash",
  sourceId: "parent-sandbox-source",
  sourceKind: "module",
};

describe("resolveSandboxDefinition", () => {
  it("resolves parent inheritance without loading the parent module from the child scope", async () => {
    await expect(
      resolveSandboxDefinition(inheritedSandbox, { nodes: { child: { modules: {} } } }, "child"),
    ).resolves.toMatchObject({
      kind: "parent",
      logicalPath: "sandbox.ts",
      sourceId: "parent-sandbox-source",
    });
  });
});
