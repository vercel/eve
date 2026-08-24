import { createRequire } from "node:module";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import { createCompiledExternalDependencySemanticHash } from "#compiler/external-dependency-plan.js";
import {
  createGenerationPackageBoundaryPlugin,
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";

const require = createRequire(import.meta.url);
const nitroRoot = dirname(require.resolve("nitro/package.json"));

function createNitroPlan(): CompiledExternalDependencyPlan {
  const entry: Omit<CompiledExternalDependencyPlan["entries"][number], "semanticSha256"> = {
    conditions: ["node", "import", "default"],
    id: "nitro",
    packageName: "nitro",
    packages: [
      {
        contentSha256: "b".repeat(64),
        dependencies: [],
        id: "0",
        packageName: "nitro",
        resolvedPackageRoot: nitroRoot,
      },
    ],
    rootPackageId: "0",
    scopes: [{ kind: "application", nodeId: "__root__", sourceRoot: "/app" }],
  };
  return {
    entries: [{ ...entry, semanticSha256: createCompiledExternalDependencySemanticHash(entry) }],
  };
}

describe("createGenerationPackageBoundaryPlugin", () => {
  it("preserves a compiler-selected subpath without generic bundler resolution", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencyMode: "preserve-specifier",
      externalDependencyPlan: createNitroPlan(),
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        throw new Error("configured externals must not use generic bundler resolution");
      },
    };

    await expect(
      resolveId.call(context, "nitro/builder", "/app/agent/tools/ping.ts", {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ external: true, id: "nitro/builder" });
  });

  it("emits the exact compiler-plan subpath for authenticated hydration", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencyMode: "resolved-path",
      externalDependencyPlan: createNitroPlan(),
    });
    const resolveId = plugin.resolveId as (
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;

    await expect(
      resolveId("nitro/builder", "/app/agent/tools/ping.ts", {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ external: true, id: require.resolve("nitro/builder") });
  });
});
