import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { stageDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledArtifactSet } from "#runtime/loaders/compiled-artifact-set.js";

const EXECUTION_COUNTER = "__eveExternalDependencySnapshotExecutionCount__";

describe("development external dependency snapshots", () => {
  const scenarioApp = useScenarioApp();

  async function createExternalDependencyApp(name: string) {
    const packageSource = (marker: string) =>
      [
        `globalThis.${EXECUTION_COUNTER} = (globalThis.${EXECUTION_COUNTER} ?? 0) + 1;`,
        `export const marker = ${JSON.stringify(marker)};`,
        "",
      ].join("\n");
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          'import { defineAgent } from "eve";',
          "export default defineAgent({",
          '  model: "openai/gpt-5.4-mini",',
          '  build: { externalDependencies: ["snapshot-runtime"] },',
          "});",
          "",
        ].join("\n"),
        "agent/instructions.md": "Use the tool.",
        "agent/tools/check.ts": [
          'import { defineTool } from "eve/tools";',
          'import { marker } from "snapshot-runtime/feature";',
          "export { marker };",
          "export default defineTool({",
          '  description: "Checks the package revision.",',
          "  inputSchema: {},",
          "  execute: async () => marker,",
          "});",
          "",
        ].join("\n"),
        "packages/snapshot-runtime/default.mjs": packageSource("default-decoy"),
        "packages/snapshot-runtime/eve-source.ts": packageSource("eve-source-decoy"),
        "packages/snapshot-runtime/import.mjs": packageSource("first"),
        "packages/snapshot-runtime/package.json": JSON.stringify({
          exports: {
            "./feature": {
              "eve-source": "./eve-source.ts",
              import: "./import.mjs",
              default: "./default.mjs",
            },
          },
          name: "snapshot-runtime",
          type: "module",
        }),
      },
      dependencies: { "snapshot-runtime": "file:./packages/snapshot-runtime" },
      installDependencies: true,
      name,
    });
    return { app, packageSource };
  }

  it("executes only the authenticated immutable package copy", async () => {
    const { app, packageSource } = await createExternalDependencyApp(
      "external-dependency-dev-snapshot",
    );
    const compileResult = await compileAgent({ startPath: app.appRoot });
    const generation = await stageDevelopmentGeneration(compileResult);
    const originalPackagePath = join(app.appRoot, "packages", "snapshot-runtime", "import.mjs");
    const snapshotPackageRoot = await realpath(
      join(generation.runtimeAppRoot, "node_modules", "snapshot-runtime"),
    );
    const snapshotPackagePath = join(snapshotPackageRoot, "import.mjs");

    expect(snapshotPackageRoot).toContain(
      join(generation.runtimeAppRoot, ".eve", "external-dependencies"),
    );
    await writeFile(originalPackagePath, packageSource("second"));
    expect(await readFile(snapshotPackagePath, "utf8")).toBe(packageSource("first"));

    const globals = globalThis as Record<string, unknown>;
    globals[EXECUTION_COUNTER] = 0;
    const loaded = await loadCompiledArtifactSet({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(generation.runtimeAppRoot),
    });
    expect(loaded.moduleMap.nodes.__root__?.modules["tools/check.ts"]?.marker).toBe("first");
    expect(globals[EXECUTION_COUNTER]).toBe(1);

    await writeFile(snapshotPackagePath, packageSource("tampered"));
    globals[EXECUTION_COUNTER] = 0;
    await expect(
      loadCompiledArtifactSet({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(
          generation.runtimeAppRoot,
        ),
      }),
    ).rejects.toThrow("changed after compilation");
    expect(globals[EXECUTION_COUNTER]).toBe(0);
    delete globals[EXECUTION_COUNTER];
  });

  it("rejects changed live package bytes before raw authored hydration executes", async () => {
    const { app, packageSource } = await createExternalDependencyApp(
      "external-dependency-raw-tamper",
    );
    await compileAgent({ startPath: app.appRoot });
    await writeFile(
      join(app.appRoot, "packages", "snapshot-runtime", "import.mjs"),
      packageSource("tampered"),
    );

    const globals = globalThis as Record<string, unknown>;
    globals[EXECUTION_COUNTER] = 0;
    await expect(
      loadCompiledArtifactSet({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
      }),
    ).rejects.toThrow("changed after compilation");
    expect(globals[EXECUTION_COUNTER]).toBe(0);
    delete globals[EXECUTION_COUNTER];
  });

  it("keeps a shared transitive package entry-local in the serialized snapshot plan", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4-mini",',
          '  build: { externalDependencies: ["snapshot-alpha", "snapshot-beta"] },',
          "};",
          "",
        ].join("\n"),
        "agent/instructions.md": "Use the shared dependency tool.",
        "agent/tools/check.mjs": [
          'import { alpha } from "snapshot-alpha";',
          'import { beta } from "snapshot-beta";',
          "export default {",
          '  description: "Checks shared transitive captures.",',
          "  inputSchema: {},",
          "  execute: async () => `${alpha}:${beta}` ,",
          "};",
          "",
        ].join("\n"),
        "node_modules/snapshot-alpha/index.mjs":
          'export { shared as alpha } from "snapshot-shared";\n',
        "node_modules/snapshot-alpha/package.json": JSON.stringify({
          dependencies: { "snapshot-shared": "1.0.0" },
          exports: "./index.mjs",
          name: "snapshot-alpha",
          type: "module",
        }),
        "node_modules/snapshot-beta/index.mjs":
          'export { shared as beta } from "snapshot-shared";\n',
        "node_modules/snapshot-beta/package.json": JSON.stringify({
          dependencies: { "snapshot-shared": "1.0.0" },
          exports: "./index.mjs",
          name: "snapshot-beta",
          type: "module",
        }),
        "node_modules/snapshot-shared/index.mjs": 'export const shared = "shared";\n',
        "node_modules/snapshot-shared/package.json": JSON.stringify({
          exports: "./index.mjs",
          name: "snapshot-shared",
          type: "module",
        }),
      },
      name: "external-dependency-shared-transitive-snapshot",
    });
    const compileResult = await compileAgent({ startPath: app.appRoot });
    const [originalAlpha, originalBeta] = compileResult.manifest.externalDependencyPlan.entries;
    const originalAlphaShared = originalAlpha!.packages.find(
      (pkg) => pkg.packageName === "snapshot-shared",
    )!;
    const originalBetaShared = originalBeta!.packages.find(
      (pkg) => pkg.packageName === "snapshot-shared",
    )!;
    expect(originalBetaShared.resolvedPackageRoot).toBe(originalAlphaShared.resolvedPackageRoot);

    const generation = await stageDevelopmentGeneration(compileResult);
    const snapshotManifest = JSON.parse(
      await readFile(
        join(generation.runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"),
        "utf8",
      ),
    ) as typeof compileResult.manifest;
    const [snapshotAlpha, snapshotBeta] = snapshotManifest.externalDependencyPlan.entries;
    const snapshotAlphaShared = snapshotAlpha!.packages.find(
      (pkg) => pkg.packageName === "snapshot-shared",
    )!;
    const snapshotBetaShared = snapshotBeta!.packages.find(
      (pkg) => pkg.packageName === "snapshot-shared",
    )!;

    expect(snapshotBetaShared.resolvedPackageRoot).not.toBe(
      snapshotAlphaShared.resolvedPackageRoot,
    );
    expect(snapshotAlphaShared.resolvedPackageRoot).toContain(snapshotAlpha!.semanticSha256);
    expect(snapshotBetaShared.resolvedPackageRoot).toContain(snapshotBeta!.semanticSha256);
  });
});
