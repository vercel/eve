import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildWithRolldown } from "#internal/bundler/rolldown.js";
import { resolvePackageRoot, resolvePackageSourceFilePath } from "#internal/application/package.js";
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
  await buildWithRolldown({
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

/**
 * Evaluates `probe` in a fresh Node process, the way a deployment loads the
 * chunk. Importing the bundle inside the vitest worker would transform it
 * through Vite first, which costs seconds and does not match production.
 *
 * The bundle leaves non-eve imports external, as Nitro's output does, so the
 * scratch root gets a `node_modules` link for the probe to resolve them from.
 */
async function runBundleProbe(input: {
  readonly probe: string;
  readonly probeArgs: readonly string[];
  readonly scratch: string;
}): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  await symlink(join(resolvePackageRoot(), "node_modules"), join(input.scratch, "node_modules"));
  const probePath = join(input.scratch, "probe.mjs");
  await writeFile(probePath, input.probe);
  const probe = spawnSync(process.execPath, [probePath, ...input.probeArgs], {
    encoding: "utf8",
  });
  return { status: probe.status, stdout: probe.stdout, stderr: probe.stderr };
}

const STEP_ENTRY_PROBE = [
  "const bundleUrl = process.argv[2];",
  "const loaded = await import(bundleUrl);",
  "process.stdout.write(JSON.stringify({ stepsRegistered: loaded.__steps_registered }));",
  "",
].join("\n");

const FRAMEWORK_NAMESPACES_PROBE = [
  "const bundleUrl = process.argv[2];",
  "const loaded = await import(bundleUrl);",
  "const registry = loaded.default.frameworkAgentSourceRegistry;",
  "const modules = registry.registrations.flatMap(",
  "  (registration) => registration.source.modules,",
  ");",
  "const failures = [];",
  "for (const module of modules) {",
  "  try {",
  "    const namespace = await module.loadNamespace();",
  '    if (namespace?.default === undefined) failures.push("missing default export");',
  "  } catch (error) {",
  "    failures.push(error instanceof Error ? error.message : String(error));",
  "  }",
  "}",
  "process.stdout.write(JSON.stringify({ count: modules.length, failures }));",
  "",
].join("\n");

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
      "src/subagents/adapter.ts",
      "src/execution/session/turn.ts",
      "src/execution/session/entry.ts",
      "src/execution/workflow-host/turn-step.ts",
    ].map((relative) => resolvePackageSourceFilePath(relative));

    const entryFile = join(scratch, "entry.mjs");
    const importLines = stepSources.map((source) => `import ${JSON.stringify(source)};`).join("\n");
    await writeFile(entryFile, `${importLines}\nexport const __steps_registered = true;\n`);

    const outfile = await bundleEveDistAsSingleChunk({
      cwd: scratch,
      entry: entryFile,
      outDir,
    });

    const probe = await runBundleProbe({
      probe: STEP_ENTRY_PROBE,
      probeArgs: [pathToFileURL(outfile).href],
      scratch,
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ stepsRegistered: true });
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

    const probe = await runBundleProbe({
      probe: FRAMEWORK_NAMESPACES_PROBE,
      probeArgs: [pathToFileURL(outfile).href],
      scratch,
    });
    expect(probe.status, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout) as { count: number; failures: string[] };
    expect(result.failures).toEqual([]);
    expect(result.count).toBeGreaterThan(0);
  }, 180_000);
});
