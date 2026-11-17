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
import { escapeRegex } from "#internal/bundler/filters.js";
import type { RolldownOutputAsset, RolldownOutputChunk } from "#internal/bundler/rolldown.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

export type CheckedBundle = Readonly<
  Record<
    string,
    | Pick<RolldownOutputChunk, "code" | "dynamicImports" | "fileName" | "imports" | "type">
    | Pick<RolldownOutputAsset, "fileName" | "type">
  >
>;

interface ExternalImport {
  readonly chunk: string;
  readonly probe: string;
  readonly specifier: string;
}

const NITRO_TRACED_ID_RE = /^nitro:traced\/\d+\/(.+)$/;

const PROBE_SOURCE = "export const resolve = (specifier) => import.meta.resolve(specifier);\n";

export async function checkExternalDependencyOutput(input: {
  readonly appRoot: string;
  readonly bundle: CheckedBundle;
  readonly externalDependencies: readonly string[];
  readonly outputDir: string;
}): Promise<void> {
  const outputDir = realpathSync(input.outputDir);
  const probeName = `.eve-resolve-${randomUUID()}.mjs`;
  const externalImports: ExternalImport[] = [];
  for (const output of Object.values(input.bundle)) {
    if (output.type !== "chunk") {
      continue;
    }
    const probe = join(dirname(join(outputDir, output.fileName)), probeName);
    for (const id of [...output.imports, ...output.dynamicImports]) {
      const traced = NITRO_TRACED_ID_RE.exec(id)?.[1];
      const specifier = traced ?? id;
      if (
        resolveConfiguredExternalDependency(specifier, input.externalDependencies) === undefined
      ) {
        continue;
      }
      if (traced !== undefined && !importsSpecifier(output.code, traced)) {
        continue;
      }
      externalImports.push({ chunk: output.fileName, probe, specifier });
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
}

function importsSpecifier(code: string, specifier: string): boolean {
  return new RegExp(
    String.raw`(?:\bfrom|\bimport)\s*\(?\s*(["'\`])${escapeRegex(specifier)}\1`,
  ).test(code);
}

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
