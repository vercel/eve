import { describe, expect, it } from "vitest";

import type { CompiledWorkspaceResourceRoot } from "../src/compiler/manifest.js";
import { docker } from "../src/public/sandbox/backends/docker.js";
import { createRuntimeSandboxRegistry } from "../src/runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "../src/runtime/types.js";

const EMPTY_RESOURCE_ROOT: CompiledWorkspaceResourceRoot = {
  logicalPath: "",
  rootEntries: [],
};

describe("createRuntimeSandboxRegistry", () => {
  it("attaches the workspace resource root descriptor to the selected sandbox", () => {
    const resolvedSandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox.ts",
      sourceId: "eve-framework:sandbox.ts",
    });
    const workspaceResourceRoot: CompiledWorkspaceResourceRoot = {
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["skills/"],
    };

    const registry = createRuntimeSandboxRegistry({
      resolvedSandbox,
      workspaceResourceRoot,
    });

    expect(registry.sandbox.definition).toBe(resolvedSandbox);
    expect(registry.sandbox.workspaceResourceRoot).toBe(workspaceResourceRoot);
  });

  it("uses the authored sandbox when provided, replacing the framework default", () => {
    const authoredSandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });

    const registry = createRuntimeSandboxRegistry({
      resolvedSandbox: authoredSandbox,
      workspaceResourceRoot: EMPTY_RESOURCE_ROOT,
    });

    expect(registry.sandbox.definition).toBe(authoredSandbox);
  });

  it("attaches the workspace resource root descriptor to the authored sandbox", () => {
    const authoredSandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });
    const workspaceResourceRoot: CompiledWorkspaceResourceRoot = {
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["skills/"],
    };

    const registry = createRuntimeSandboxRegistry({
      resolvedSandbox: authoredSandbox,
      workspaceResourceRoot,
    });

    expect(registry.sandbox.definition).toBe(authoredSandbox);
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
    sourceHash: `test:${input.sourceId}`,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}
