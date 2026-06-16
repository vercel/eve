import { describe, expect, it } from "vitest";

import type { CompiledWorkspaceResourceRoot } from "../src/compiler/manifest.js";
import { docker } from "../src/public/sandbox/backends/docker.js";
import {
  createFrameworkSandboxDefinition,
  createRuntimeSandboxRegistry,
  DEFAULT_SANDBOX_SOURCE_ID,
} from "../src/runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "../src/runtime/types.js";

const EMPTY_RESOURCE_ROOT: CompiledWorkspaceResourceRoot = {
  logicalPath: "",
  rootEntries: [],
};

describe("createRuntimeSandboxRegistry", () => {
  it("falls back to the framework default sandbox when no authored override is present", () => {
    const registry = createRuntimeSandboxRegistry({
      authoredSandbox: null,
      workspaceResourceRoot: EMPTY_RESOURCE_ROOT,
    });

    expect(registry.sandbox?.definition.sourceId).toBe(DEFAULT_SANDBOX_SOURCE_ID);
    expect(registry.sandbox?.workspaceResourceRoot).toBe(EMPTY_RESOURCE_ROOT);
  });

  it("attaches the workspace resource root descriptor to the framework default", () => {
    const workspaceResourceRoot: CompiledWorkspaceResourceRoot = {
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["skills/"],
    };

    const registry = createRuntimeSandboxRegistry({
      authoredSandbox: null,
      workspaceResourceRoot,
    });

    expect(registry.sandbox?.definition.sourceId).toBe(DEFAULT_SANDBOX_SOURCE_ID);
    expect(registry.sandbox?.workspaceResourceRoot).toBe(workspaceResourceRoot);
  });

  it("uses the authored sandbox when provided, replacing the framework default", () => {
    const authoredSandbox = createResolvedSandboxDefinition({
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });

    const registry = createRuntimeSandboxRegistry({
      authoredSandbox,
      workspaceResourceRoot: EMPTY_RESOURCE_ROOT,
    });

    expect(registry.sandbox?.definition).toBe(authoredSandbox);
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
      authoredSandbox,
      workspaceResourceRoot,
    });

    expect(registry.sandbox?.definition).toBe(authoredSandbox);
    expect(registry.sandbox?.workspaceResourceRoot).toBe(workspaceResourceRoot);
  });

  it("createFrameworkSandboxDefinition resolves a fresh default backend on each call", () => {
    const definition = createFrameworkSandboxDefinition();

    expect(definition.sourceId).toBe(DEFAULT_SANDBOX_SOURCE_ID);
    expect(definition.sourceKind).toBe("module");
    expect(typeof definition.backend.name).toBe("string");
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
