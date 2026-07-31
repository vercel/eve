import { describe, expect, it } from "vitest";

import type { CompiledWorkspaceResourceRoot } from "../src/compiler/manifest.js";
import type { Sandbox } from "../src/public/definitions/sandbox.js";
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
      templateReferences: {},
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
      templateReferences: {},
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
      templateReferences: {},
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
      templateReferences: {},
      workspaceResourceRoot,
    });

    expect(registry.sandbox?.definition).toBe(authoredSandbox);
    expect(registry.sandbox?.workspaceResourceRoot).toBe(workspaceResourceRoot);
  });

  it("creates a template-less framework definition without managed files", () => {
    const definition = createFrameworkSandboxDefinition({ hasWorkspace: false });

    expect(definition.sourceId).toBe(DEFAULT_SANDBOX_SOURCE_ID);
    expect(definition.sourceKind).toBe("module");
    expect(typeof definition.definition).toBe("function");
    expect(definition.templates).toEqual([]);
  });

  it("exports a framework template when managed files need build prewarming", () => {
    const reference = { provider: "test", snapshotId: "snapshot_1" };
    const definition = createFrameworkSandboxDefinition({
      hasWorkspace: true,
      templateReferences: { template: reference },
    });

    expect(definition.templates).toHaveLength(1);
    expect(definition.templates[0]?.exportName).toBe("template");
    expect(definition.templates[0]?.reference).toBe(reference);
  });
});

function createResolvedSandboxDefinition(input: {
  readonly logicalPath: string;
  readonly sourceId: string;
}): ResolvedSandboxDefinition {
  return {
    definition: () => ({}) as Sandbox,
    logicalPath: input.logicalPath,
    sourceHash: "sandbox-source-hash",
    sourceId: input.sourceId,
    sourceKind: "module",
    templates: [],
  };
}
