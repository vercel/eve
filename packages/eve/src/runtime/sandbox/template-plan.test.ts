import { describe, expect, it } from "vitest";

import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

const definition = {
  backend: { name: "test" },
  logicalPath: "agent/sandbox.ts",
  sourceId: "agent/sandbox",
  sourceKind: "module",
} as ResolvedSandboxDefinition;

const resourceRoot = {
  contentHash: "same-content",
  logicalPath: "workspace-resources/worker",
  rootEntries: ["skills/research"],
};

describe("createRuntimeSandboxTemplatePlan", () => {
  it("changes content identity when the inherited agent home changes", () => {
    const first = createRuntimeSandboxTemplatePlan({
      definition,
      inheritedWorkspaceResourceRoots: [
        {
          resourceRoot,
          skillStoreLocation: { home: "/agents/worker-a-00000000" },
        },
      ],
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    });
    const second = createRuntimeSandboxTemplatePlan({
      definition,
      inheritedWorkspaceResourceRoots: [
        {
          resourceRoot,
          skillStoreLocation: { home: "/agents/worker-b-00000000" },
        },
      ],
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    });

    expect(first).toMatchObject({ kind: "workspace-content" });
    expect(second).toMatchObject({ kind: "workspace-content" });
    expect(first).not.toEqual(second);
  });
});
