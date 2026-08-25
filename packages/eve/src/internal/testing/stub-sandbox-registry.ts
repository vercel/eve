import { defaultSandbox } from "#public/sandbox/backends/default.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";

/**
 * Stub registry for tests that exercise harness/execution paths that do
 * not touch the sandbox itself.
 *
 * Production code constructs registries via
 * `createRuntimeSandboxRegistry` from the resolved authored graph;
 * `RuntimeSandboxRegistry.sandbox` is non-null there. Tests that need a
 * registry but never call into the sandbox use this helper.
 */
export function createStubSandboxRegistry(): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        backend: defaultSandbox(),
        logicalPath: "sandbox.ts",
        sourceId: "test:stub-sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: {
        logicalPath: "test:stub-sandbox/workspace",
        rootEntries: [],
      },
    },
  };
}
