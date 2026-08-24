import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCompiledAgentManifest, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineExtension } from "#public/definitions/extension.js";
import {
  registerExtensionConfigs,
  runWithExtensionRegistration,
  wrapExtensionCallbacks,
} from "#runtime/extension-registrations.js";

describe("extension registrations", () => {
  it("selects config by mount path and propagates it to returned callbacks", async () => {
    const extension = defineExtension({
      config: z.object({ label: z.string() }),
    });
    const first = extension({ label: "first" });
    const second = extension({ label: "second" });
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: "openai/gpt-5.4",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "test-agent",
      },
      extensionMounts: [
        {
          mountLogicalPath: "extensions/first.ts",
          mountSourceId: "extensions/first",
          namespace: "first",
          packageName: "@acme/shared",
          packageNamespace: "acme-shared",
          sourceRoot: "/app/node_modules/@acme/shared/extension",
        },
        {
          mountLogicalPath: "extensions/second.ts",
          mountSourceId: "extensions/second",
          namespace: "second",
          packageName: "@acme/shared",
          packageNamespace: "acme-shared",
          sourceRoot: "/app/node_modules/@acme/shared/extension",
        },
      ],
    });
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "extensions/first": { default: first },
            "extensions/second": { default: second },
          },
        },
      },
    };
    registerExtensionConfigs(manifest, moduleMap);

    const createFirstTool = wrapExtensionCallbacks({
      moduleMap,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourceId: "ext:first:tools/read-label",
      logicalPath: "../node_modules/@acme/shared/extension/tools/read-label.ts",
      value: Object.assign(() => ({ execute: () => extension.config.label }), {
        marker: "preserved",
      }),
    });
    const createSecondTool = wrapExtensionCallbacks({
      moduleMap,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourceId: "ext:second:tools/read-label",
      logicalPath: "../node_modules/@acme/shared/extension/tools/read-label.ts",
      value: () => ({ execute: () => extension.config.label }),
    });

    expect(createFirstTool.marker).toBe("preserved");
    expect(createFirstTool().execute()).toBe("first");
    expect(createSecondTool().execute()).toBe("second");

    const callUnownedCode = wrapExtensionCallbacks({
      moduleMap,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourceId: "ext:first:tools/call-unowned",
      logicalPath: "../node_modules/@acme/shared/extension/tools/call-unowned.ts",
      value: () =>
        runWithExtensionRegistration({
          moduleMap,
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          sourceId: "tools/local",
          logicalPath: "tools/local.ts",
          operation: () => extension.config.label,
        }),
    });
    expect(callUnownedCode()).toBe("second");

    const returnsItself = () => returnsItself;
    const wrappedReturnsItself = wrapExtensionCallbacks({
      moduleMap,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourceId: "ext:first:tools/self",
      logicalPath: "../node_modules/@acme/shared/extension/tools/self.ts",
      value: returnsItself,
    });
    expect(wrappedReturnsItself()).toBe(wrappedReturnsItself);

    let thenMethodLabel: string | undefined;
    const returnsThenable = wrapExtensionCallbacks({
      moduleMap,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourceId: "ext:first:tools/thenable",
      logicalPath: "../node_modules/@acme/shared/extension/tools/thenable.ts",
      value: () => ({
        // oxlint-disable-next-line unicorn/no-thenable -- Verifies custom PromiseLike assimilation.
        then(resolve: (callback: () => string) => void) {
          thenMethodLabel = extension.config.label;
          resolve(() => extension.config.label);
        },
      }),
    });
    const resolvedCallback = await returnsThenable();
    expect(thenMethodLabel).toBe("first");
    expect(resolvedCallback()).toBe("first");
  });
});
