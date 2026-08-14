import { describe, expect, it } from "vitest";

import {
  createRuntimeLoaderPackageBoundaryPlugin,
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";

describe("createRuntimeLoaderPackageBoundaryPlugin", () => {
  it.each([
    [
      "C:\\workspace\\app\\node_modules\\external-only\\index.js",
      "file:///C:/workspace/app/node_modules/external-only/index.js",
    ],
    [
      "\\\\server\\share\\app\\node_modules\\external-only\\index.js",
      "file://server/share/app/node_modules/external-only/index.js",
    ],
    [
      "/workspace/app/node_modules/external-only/index.js",
      "/workspace/app/node_modules/external-only/index.js",
    ],
    ["external-only", "external-only"],
  ])("emits resolved external %s as %s", async (resolvedId, expectedId) => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: ["external-only"],
      packageRoot: "C:\\workspace\\app",
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        return { id: resolvedId };
      },
    };

    await expect(
      resolveId.call(context, "external-only", "C:\\workspace\\app\\agent\\tools\\ping.ts", {
        kind: "import-statement",
      }),
    ).resolves.toEqual({
      external: true,
      id: expectedId,
    });
  });
});
