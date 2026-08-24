import { describe, expect, it } from "vitest";

import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";

const SOURCE_HASH = "a".repeat(64);

function createDefinition(
  input: Partial<ResolvedSandboxDefinition> = {},
): ResolvedSandboxDefinition {
  return {
    backend: { name: "test" } as ResolvedSandboxDefinition["backend"],
    logicalPath: "sandbox.ts",
    sourceHash: SOURCE_HASH,
    sourceId: "opaque:sandbox",
    sourceKind: "module",
    ...input,
  };
}

describe("createRuntimeSandboxTemplatePlan", () => {
  it("carries the selected source identity when no template is needed", () => {
    expect(
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition(),
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toEqual({ kind: "none", sourceHash: SOURCE_HASH });
  });

  it("carries the selected source identity with workspace content", () => {
    expect(
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition(),
        workspaceResourceRoot: {
          contentHash: "b".repeat(64),
          logicalPath: "workspace-resources/root",
          rootEntries: ["seed.txt"],
        },
      }),
    ).toEqual({
      contentHash: "b".repeat(64),
      kind: "workspace-content",
      sourceHash: SOURCE_HASH,
    });
  });

  it("carries the selected source identity with bootstrap metadata", () => {
    expect(
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition({
          async bootstrap() {},
          revalidationKey: "bootstrap-v1",
        }),
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toEqual({
      contentHash: undefined,
      kind: "bootstrap",
      revalidationKey: "bootstrap-v1",
      sourceHash: SOURCE_HASH,
    });
  });

  it("rejects a resolved sandbox without compiled source identity", () => {
    expect(() =>
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition({ sourceHash: undefined as never }),
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toThrow('Sandbox "sandbox.ts" has no compiled sourceHash.');
  });

  it("rejects managed workspace resources without compiled content identity", () => {
    expect(() =>
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition(),
        workspaceResourceRoot: {
          logicalPath: "workspace-resources/root",
          rootEntries: ["seed.txt"],
        },
      }),
    ).toThrow('Sandbox "sandbox.ts" has managed workspace resources but no compiled contentHash.');
  });
});
