import { describe, expect, it } from "vitest";

import type { CompiledWorkspaceResourceRoot } from "../src/compiler/manifest.js";
import { docker } from "../src/public/sandbox/backends/docker.js";
import { createRuntimeSandboxRegistry } from "../src/runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "../src/runtime/types.js";

const EMPTY_RESOURCE_ROOT: CompiledWorkspaceResourceRoot = {
  logicalPath: "",
  rootEntries: [],
};

// The runtime sandbox fallback is deleted: every compiled node carries
// exactly one selected sandbox (the framework default composes like any
// other source at compile time), so the registry registers the resolved
// sandbox verbatim.
describe("createRuntimeSandboxRegistry", () => {
  it("registers the resolved sandbox verbatim", () => {
    const sandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });

    const registry = createRuntimeSandboxRegistry({
      sandbox,
      workspaceResourceRoot: EMPTY_RESOURCE_ROOT,
    });

    expect(registry.sandbox.definition).toBe(sandbox);
    expect(registry.sandbox.workspaceResourceRoot).toBe(EMPTY_RESOURCE_ROOT);
  });

  it("attaches the workspace resource root descriptor to the resolved sandbox", () => {
    const sandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });
    const workspaceResourceRoot: CompiledWorkspaceResourceRoot = {
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["skills/"],
    };

    const registry = createRuntimeSandboxRegistry({
      sandbox,
      workspaceResourceRoot,
    });

    expect(registry.sandbox.definition).toBe(sandbox);
    expect(registry.sandbox.workspaceResourceRoot).toBe(workspaceResourceRoot);
  });
});

function createResolvedSandboxDefinition(input: {
  readonly logicalPath: string;
  readonly sourceId: string;
}): ResolvedSandboxDefinition {
  return {
    backend: docker(),
    logicalPath: input.logicalPath,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}
