import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  packageImportName,
  resolveConfiguredExternalDependency,
} from "#internal/authored-package-boundary.js";
import {
  createNitroRolldownNodeImportResolver,
  type RolldownOutputAsset,
  type RolldownOutputChunk,
} from "#internal/bundler/nitro-rolldown.js";
import { isPathInsideOrEqual } from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

interface ExternalDependencyOutputCheckPlugin {
  readonly name: string;
  writeBundle(
    outputOptions: { readonly dir: string },
    bundle: Readonly<Record<string, RolldownOutputChunk | RolldownOutputAsset>>,
  ): Promise<void>;
}

/**
 * Fails the hosted build when a written chunk imports (statically or by a
 * literal dynamic import) a configured external that does not resolve, from
 * that chunk, to a file inside the output. Nitro's tracer only warns when it
 * cannot find a package to copy, so without this check the build succeeds
 * and the deployed function fails with ERR_MODULE_NOT_FOUND (or
 * ERR_PACKAGE_PATH_NOT_EXPORTED when it copied a different version).
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
      const resolver = await createNitroRolldownNodeImportResolver();
      const outputDir = realpathSync(outputOptions.dir);
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }
        const chunkDir = dirname(join(outputDir, output.fileName));
        for (const specifier of [...output.imports, ...output.dynamicImports]) {
          if (
            resolveConfiguredExternalDependency(specifier, input.externalDependencies) === undefined
          ) {
            continue;
          }
          const resolved = resolver.sync(chunkDir, specifier).path;
          if (resolved === undefined || !isPathInsideOrEqual(realpathSync(resolved), outputDir)) {
            const packageName = packageImportName(specifier);
            throw new Error(
              `"${specifier}" is listed in build.externalDependencies and imported by the hosted bundle (${output.fileName}), but the build output cannot resolve it. Add "${packageName}" to the dependencies in ${join(input.appRoot, "package.json")}.`,
            );
          }
        }
      }
    },
  };
}
