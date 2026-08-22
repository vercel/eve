import { describe, expect, it } from "vitest";

import { createCompiledAgentResources } from "#compiler/manifest.js";
import {
  assertTotalModuleBindings,
  createFilesystemModuleBindings,
} from "#compiler/module-binding.js";

function createResources() {
  return createCompiledAgentResources({
    agentRoot: "/app/agent",
    appRoot: "/app",
    extensionMounts: [
      {
        externalDependencies: ["extension-runtime"],
        mountLogicalPath: "extensions/crm.ts",
        mountSourceId: "extensions/crm.ts",
        namespace: "crm",
        packageName: "@acme/crm",
        packageNamespace: "acme-crm",
        sourceRoot: "/packages/crm/extension",
      },
    ],
    tools: [
      {
        description: "Searches CRM records.",
        inputSchema: null,
        logicalPath: "../../packages/crm/extension/tools/search.ts",
        name: "crm__search",
        sourceId: "ext:crm:tools/search.ts",
        sourceKind: "module",
      },
    ],
  });
}

describe("compiled module bindings", () => {
  it("separates consumer-visible identity from extension package storage", () => {
    const resources = createResources();
    const bindings = createFilesystemModuleBindings({
      agentRoot: resources.agentRoot,
      externalDependencies: ["app-runtime", "extension-runtime"],
      manifest: resources,
    });

    expect(bindings["ext:crm:tools/search.ts"]).toEqual({
      backing: {
        externalDependencies: ["app-runtime", "extension-runtime"],
        extensionScope: {
          namespace: "acme-crm",
          sourceRoot: "/packages/crm/extension",
        },
        kind: "filesystem",
        sourcePath: "/packages/crm/extension/tools/search.ts",
      },
      logicalPath: "../../packages/crm/extension/tools/search.ts",
      owner: {
        kind: "extension",
        namespace: "crm",
        packageName: "@acme/crm",
      },
    });
  });

  it("rejects missing and unreferenced bindings", () => {
    const resources = createResources();

    expect(() =>
      assertTotalModuleBindings({
        bindings: {},
        manifest: resources,
        nodeId: "__root__",
      }),
    ).toThrow('missing a binding for "ext:crm:tools/search.ts"');

    expect(() =>
      assertTotalModuleBindings({
        bindings: {
          ...createFilesystemModuleBindings({
            agentRoot: resources.agentRoot,
            manifest: resources,
          }),
          extra: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/tools/extra.ts",
            },
            logicalPath: "tools/extra.ts",
            owner: { kind: "application" },
          },
        },
        manifest: resources,
        nodeId: "__root__",
      }),
    ).toThrow('unreferenced binding for "extra"');
  });
});
