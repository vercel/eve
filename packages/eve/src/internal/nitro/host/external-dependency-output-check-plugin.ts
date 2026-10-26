import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  packageImportName,
  resolveConfiguredExternalDependency,
} from "#internal/authored-package-boundary.js";
import type { RolldownOutputAsset, RolldownOutputChunk } from "#internal/bundler/nitro-rolldown.js";
import { isPathInsideOrEqual } from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

interface ExternalDependencyOutputCheckPlugin {
  readonly name: string;
  writeBundle(
    outputOptions: { readonly dir: string },
    bundle: Readonly<Record<string, RolldownOutputChunk | RolldownOutputAsset>>,
  ): Promise<void>;
}

interface ExternalImport {
  readonly chunk: string;
  readonly probe: string;
  readonly specifier: string;
}

/** Placed beside a chunk, so `import.meta.resolve` resolves exactly as that chunk's imports do. */
const PROBE_SOURCE = "export const resolve = (specifier) => import.meta.resolve(specifier);\n";

/**
 * Fails the hosted build when a written chunk imports (statically or by a
 * literal dynamic import) a configured external that Node does not resolve,
 * from that chunk, to a file inside the output. Nitro's tracer only warns
 * when it cannot find a package to copy, so without this check the build
 * succeeds and the deployed function fails with ERR_MODULE_NOT_FOUND (or
 * ERR_PACKAGE_PATH_NOT_EXPORTED when it copied a different version).
 *
 * Resolution is Node's own ESM resolver, run by the build's Node in a child
 * process; no dependency code is loaded.
 */
export function createExternalDependencyOutputCheckPlugin(input: {
  readonly appRoot: string;
  readonly externalDependencies: readonly string[];
}): ExternalDependencyOutputCheckPlugin | null {
  if (input.externalDependencies.length === 0) {
    return null;
  }

  return {
    name: "eve-external-dependency-output-check",
    async writeBundle(outputOptions, bundle) {
      const outputDir = realpathSync(outputOptions.dir);
      const probeName = `.eve-resolve-${randomUUID()}.mjs`;
      const externalImports: ExternalImport[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }
        const probe = join(dirname(join(outputDir, output.fileName)), probeName);
        for (const specifier of [...output.imports, ...output.dynamicImports]) {
          if (
            resolveConfiguredExternalDependency(specifier, input.externalDependencies) !== undefined
          ) {
            externalImports.push({ chunk: output.fileName, probe, specifier });
          }
        }
      }
      if (externalImports.length === 0) {
        return;
      }

      const resolved = await resolveWithNode(outputDir, probeName, externalImports);
      externalImports.forEach(({ chunk, specifier }, index) => {
        const url = resolved[index];
        const path = url?.startsWith("file:") === true ? fileURLToPath(url) : undefined;
        if (
          path === undefined ||
          statSync(path, { throwIfNoEntry: false })?.isFile() !== true ||
          !isPathInsideOrEqual(path, outputDir)
        ) {
          throw new Error(
            `"${specifier}" is listed in build.externalDependencies and imported by the hosted bundle (${chunk}), but the build output cannot resolve it. Add "${packageImportName(specifier)}" to the dependencies in ${join(input.appRoot, "package.json")}.`,
          );
        }
      });
    },
  };
}

/**
 * Returns, for each import, the URL Node's ESM resolver selects from beside
 * its chunk, or null when resolution throws. `import.meta.resolve` returns an
 * `exports` target's URL even when that file is missing, so callers must
 * check the file exists.
 */
async function resolveWithNode(
  outputDir: string,
  probeName: string,
  externalImports: readonly ExternalImport[],
): Promise<readonly (string | null)[]> {
  const probes = [...new Set(externalImports.map(({ probe }) => probe))];
  const driver = join(outputDir, probeName.replace(/\.mjs$/, "-driver.mjs"));
  const requests = externalImports.map(({ probe, specifier }) => ({
    probe: pathToFileURL(probe).href,
    specifier,
  }));
  try {
    await Promise.all(probes.map((probe) => writeFile(probe, PROBE_SOURCE)));
    await writeFile(
      driver,
      [
        `const results = [];`,
        `for (const { probe, specifier } of ${JSON.stringify(requests)}) {`,
        `  const { resolve } = await import(probe);`,
        `  try { results.push(resolve(specifier)); } catch { results.push(null); }`,
        `}`,
        `process.stdout.write(JSON.stringify(results));`,
        ``,
      ].join("\n"),
    );
    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(process.execPath, [driver], {
        cwd: outputDir,
        env,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (error) {
      // execFile's message carries the child's stderr.
      throw new Error(
        `Cannot check build.externalDependencies in the hosted output: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return JSON.parse(stdout) as (string | null)[];
  } finally {
    await Promise.all([driver, ...probes].map((path) => rm(path, { force: true })));
  }
}
