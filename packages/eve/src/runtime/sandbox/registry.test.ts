import { describe, expect, it } from "vitest";

import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { createRuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";

const inheritedDefinition = {
  backend: { name: "test" },
  inheritsParent: true,
  logicalPath: "agent/subagents/foo/sandbox.ts",
  sourceId: "agent/subagents/foo/sandbox",
  sourceKind: "module",
} as ResolvedSandboxDefinition;

describe("createRuntimeSandboxRegistry", () => {
  it("allows an empty child to inherit its parent sandbox", () => {
    expect(
      createRuntimeSandboxRegistry({
        sandbox: inheritedDefinition,
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toMatchObject({
      sandbox: { definition: inheritedDefinition },
    });
  });

  it("rejects child workspace resources when inheriting the parent sandbox", () => {
    expect(() =>
      createRuntimeSandboxRegistry({
        sandbox: inheritedDefinition,
        workspaceResourceRoot: {
          contentHash: "child-content",
          logicalPath: "workspace-resources/foo",
          rootEntries: ["bar.txt"],
        },
      }),
    ).toThrow(
      'Sandbox "agent/subagents/foo/sandbox.ts" selects parent.sandbox but has managed workspace resources. Remove the child workspace or give the child its own sandbox.',
    );
  });
});
