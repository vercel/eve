import { createRequire } from "node:module";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import { createCompiledExternalDependencySemanticHash } from "#compiler/external-dependency-plan.js";
import { createCompiledExternalDependencyPlugin } from "#internal/nitro/host/compiled-external-dependency-plugin.js";

const require = createRequire(import.meta.url);
const nitroRoot = dirname(require.resolve("nitro/package.json"));

function createPlan(): CompiledExternalDependencyPlan {
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

describe("compiled external dependency plugin", () => {
  it("keeps subpath imports bare while tracing the exact plan-selected target", () => {
    const tracedPaths: Record<string, string> = {};
    const plugin = createCompiledExternalDependencyPlugin({ plan: createPlan(), tracedPaths });

    expect(plugin?.resolveId("nitro/builder")).toEqual({
      external: true,
      id: "nitro/builder",
    });
    expect(tracedPaths).toEqual({ "nitro/builder": require.resolve("nitro/builder") });
    expect(plugin?.resolveId("unconfigured-runtime")).toBeNull();
  });

  it("omits the plugin without compiled requirements", () => {
    expect(
      createCompiledExternalDependencyPlugin({ plan: { entries: [] }, tracedPaths: {} }),
    ).toBeNull();
  });
});
