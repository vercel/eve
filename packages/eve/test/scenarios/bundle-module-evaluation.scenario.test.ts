import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildWithNitroRolldown } from "#internal/bundler/nitro-rolldown.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

function isEveOwnedSpecifier(source: string): boolean {
  if (source.startsWith("#")) {
    return true;
  }
  if (source.startsWith(".") || source.startsWith("/")) {
    return true;
  }
  return false;
}

interface RolldownInputOptions {
  readonly cwd: string;
  readonly entry: string;
  readonly outDir: string;
}

/**
 * Bundles one entry against the local eve dist into a single concatenated
 * chunk, mirroring the shape of Nitro's `_libs/eve.mjs`.
 * Externalizes non-eve specifiers so the test exercises eve's evaluation
 * order in isolation. Leaves `output.topLevelVar` at the rolldown default
 * (`false`) so any cycle surfaces as a loud TDZ ReferenceError at load.
 */
async function bundleEveDistAsSingleChunk(input: RolldownInputOptions): Promise<string> {
  await buildWithNitroRolldown({
    cwd: input.cwd,
    input: input.entry,
    platform: "node",
    external: (source: string, importer: string | undefined) => {
      if (importer === undefined) {
        return false;
      }
      return !isEveOwnedSpecifier(source);
    },
    resolve: {
      conditionNames: ["eve-source"],
      mainFields: ["module", "main"],
    },
    treeshake: false,
    output: {
      dir: input.outDir,
      entryFileNames: "bundle.mjs",
      codeSplitting: false,
      format: "esm",
      sourcemap: false,
    },
  });
  return join(input.outDir, "bundle.mjs");
}

describe("eve dist single-chunk module evaluation", () => {
  it("concatenates the eve dist for a Nitro-style step entry without leaving any imported binding in TDZ", async () => {
    // Regression test for a module-evaluation cycle in the BundleKey
    // codec that surfaced as a TDZ ReferenceError when the dist was
    // concatenated into a single chunk.
    const scratch = await createScratchDirectory("eve-step-entry-eval-");
    const outDir = join(scratch, "out");
    await mkdir(outDir, { recursive: true });

    // Mirror the imports `writeNitroStepEntrypoint` generates for a
    // workflow's `steps.mjs`.
    const stepSources = [
      "src/internal/workflow/builtins.ts",
      "src/execution/session-callback-step.ts",
      "src/execution/subagent-adapter.ts",
      "src/execution/turn-workflow.ts",
      "src/execution/workflow-entry.ts",
      "src/execution/workflow-steps.ts",
    ].map((relative) => resolvePackageSourceFilePath(relative));

    const entryFile = join(scratch, "entry.mjs");
    const importLines = stepSources.map((source) => `import ${JSON.stringify(source)};`).join("\n");
    await writeFile(entryFile, `${importLines}\nexport const __steps_registered = true;\n`);

    const outfile = await bundleEveDistAsSingleChunk({
      cwd: scratch,
      entry: entryFile,
      outDir,
    });

    const loaded = await import(pathToFileURL(outfile).href);
    expect(loaded.__steps_registered).toBe(true);
  }, 180_000);

  it("loads every framework programmatic namespace from the concatenated chunk", async () => {
    const scratch = await createScratchDirectory("eve-framework-sources-eval-");
    const outDir = join(scratch, "out");
    await mkdir(outDir, { recursive: true });

    const entryFile = join(scratch, "entry.mjs");
    const eveEntry = resolvePackageSourceFilePath("src/framework/sources/registry.ts");
    await writeFile(
      entryFile,
      `import * as sources from ${JSON.stringify(eveEntry)};\nexport default sources;\n`,
    );

    const outfile = await bundleEveDistAsSingleChunk({
      cwd: scratch,
      entry: entryFile,
      outDir,
    });

    const loaded = await import(pathToFileURL(outfile).href);
    const registry = loaded.default.frameworkAgentSourceRegistry;
    const modules = registry.registrations.flatMap(
      (registration: {
        applyTo: string;
        source: { modules: Array<{ loadNamespace(): Promise<unknown> }> };
      }) => (registration.applyTo === "loader-only" ? [] : registration.source.modules),
    );
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      await expect(module.loadNamespace()).resolves.toMatchObject({ default: expect.anything() });
    }
  }, 180_000);
});
