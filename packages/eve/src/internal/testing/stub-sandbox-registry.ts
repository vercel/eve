import { defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { DefaultSandbox } from "#sandbox/providers.js";

export function createStubSandboxRegistry(): RuntimeSandboxRegistry {
  const environment = DefaultSandbox.environment();
  return {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "stub-sandbox-revision",
        selector: defineSandbox(() => environment.open()),
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
