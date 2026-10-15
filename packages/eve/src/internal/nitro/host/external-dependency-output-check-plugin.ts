import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import { packageImportName } from "#internal/authored-package-boundary.js";

interface WrittenOutput {
  readonly type: string;
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

interface ExternalDependencyOutputCheckPlugin {
  readonly name: string;
  writeBundle(
    outputOptions: { readonly dir: string },
    bundle: Readonly<Record<string, WrittenOutput>>,
  ): void;
}

/**
 * Fails the hosted build when a written chunk imports (statically or by a
 * literal dynamic import) a configured
 * external that the output itself cannot resolve. Nitro's tracer only warns
 * when it cannot find a package to copy, so without this check the build
 * succeeds and the deployed function fails with ERR_MODULE_NOT_FOUND.
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
    writeBundle(outputOptions, bundle) {
      const outputDir = realpathSync(outputOptions.dir);
      for (const output of Object.values(bundle)) {
        const specifiers =
          output.type === "chunk"
            ? [...(output.imports ?? []), ...(output.dynamicImports ?? [])]
            : [];
        for (const specifier of specifiers) {
          const dependency = input.externalDependencies.find(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          );
          if (dependency === undefined) {
            continue;
          }
          const packageName = packageImportName(specifier);
          if (!outputContainsPackage(join(outputDir, output.fileName), packageName, outputDir)) {
            throw new Error(
              `"${packageName}" is listed in build.externalDependencies and imported by the hosted bundle (${output.fileName}), but the build output does not contain it. Add "${packageName}" to the dependencies in ${join(input.appRoot, "package.json")}.`,
            );
          }
        }
      }
    },
  };
}

// Node's package lookup from the importing chunk: the nearest
// node_modules/<name> wins, and it must be part of the output, not a
// directory above it that a deployment won't have.
function outputContainsPackage(importer: string, packageName: string, outputDir: string): boolean {
  const packageJsonPath = createRequire(importer)
    .resolve.paths(packageName)
    ?.map((searchPath) => join(searchPath, packageName, "package.json"))
    .find(existsSync);
  if (packageJsonPath === undefined) {
    return false;
  }
  const location = relative(outputDir, realpathSync(packageJsonPath));
  return !location.startsWith("..");
}
