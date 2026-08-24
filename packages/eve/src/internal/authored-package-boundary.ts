import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import {
  createCompiledExternalDependencyCaptureFromPackagePath,
  resolveCompiledExternalDependencyImport,
} from "#compiler/external-dependency-plan.js";
import { materializeCompiledExternalDependencyPlan } from "#internal/materialize-external-dependencies.js";

export const CACHED_CHANNEL_PREFIX = "eve-cached-channel:";

export const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

type RolldownResolveResult = {
  readonly id: string;
};

export type RolldownResolveContext = {
  resolve(
    source: string,
    importer: string | undefined,
    options: { kind: string; skipSelf: boolean },
  ): Promise<RolldownResolveResult | null>;
};

export type GenerationExternalDependencyMode = "preserve-specifier" | "resolved-path";

export function createGenerationPackageBoundaryPlugin(input: {
  readonly externalDependencyMode: GenerationExternalDependencyMode;
  readonly externalDependencyPlan: CompiledExternalDependencyPlan;
}): Record<string, unknown> {
  return {
    name: "eve-generation-package-boundary",
    async resolveId(source: string, importer: string | undefined) {
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (isFrameworkRuntimeImport(source, importer)) {
        return {
          external: true,
          id: source,
        };
      }

      const resolution = resolveCompiledExternalDependencyImport(
        input.externalDependencyPlan,
        source,
      );
      if (resolution === undefined) {
        return undefined;
      }

      return {
        external: true,
        id:
          input.externalDependencyMode === "preserve-specifier"
            ? source
            : normalizeEsmImportSpecifier(resolution.resolvedPath),
      };
    },
  };
}

export function createRuntimeLoaderPackageBoundaryPlugin(input: {
  readonly captureExternalDependencyPlan?: (input: {
    readonly packageName: string;
    readonly resolvedPackagePath: string;
  }) => Promise<CompiledExternalDependencyPlan>;
  readonly externalDependencyPlan: CompiledExternalDependencyPlan;
  readonly packageRoot: string;
}): Record<string, unknown> {
  const canonicalPackageRoot = toCanonicalPath(input.packageRoot);

  return {
    name: "eve-runtime-loader-package-boundary",
    async resolveId(
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) {
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (isFrameworkRuntimeImport(source, importer)) {
        return { external: true, id: source };
      }

      const externalModule = resolveCompiledExternalDependencyImport(
        input.externalDependencyPlan,
        source,
      );
      if (externalModule !== undefined) {
        return {
          external: true,
          id: normalizeEsmImportSpecifier(externalModule.resolvedPath),
        };
      }

      const importerPath =
        importer === undefined ||
        importer.startsWith("\0") ||
        importer.startsWith(CACHED_CHANNEL_PREFIX)
          ? undefined
          : resolve(importer);

      // Resolve app-authored package imports eagerly so compile-time
      // definitions execute from the content-addressed bundle, not Node's
      // process-wide package module cache. Runtime generation bundling uses a
      // separate boundary that preserves explicitly configured externals.
      if (
        importerPath !== undefined &&
        isPathInsideOrEqual(toCanonicalPath(importerPath), canonicalPackageRoot)
      ) {
        const resolved = await this.resolve(source, importer, {
          kind: options.kind,
          skipSelf: true,
        });

        if (resolved === null || typeof resolved.id !== "string") {
          // Failing here (instead of emitting the bare specifier as an
          // external) is load-bearing: importing a bundle whose package is
          // missing poisons Node's process-wide package-config cache with a
          // negative entry, and once the package is installed the same
          // long-running process keeps failing resolution until restart.
          // The bundler's resolver is fresh on every rebuild, so failing at
          // bundle time keeps the dev server able to recover after install.
          throw new Error(
            `Cannot resolve package "${source}" imported from "${importerPath}". ` +
              `Install it with your package manager (e.g. \`pnpm install\`); ` +
              `a running \`eve dev\` retries on the next rebuild.`,
          );
        }

        if (isNodeModulesPath(resolved.id)) {
          return {
            external: true,
            id: normalizeEsmImportSpecifier(
              await captureCompileTimeExternalPackage({
                packageName: packageImportName(source),
                packageRoot: input.packageRoot,
                planProvider: input.captureExternalDependencyPlan,
                resolvedId: resolved.id,
              }),
            ),
          };
        }
        return resolved;
      }

      const resolved = await this.resolve(source, importer, {
        kind: options.kind,
        skipSelf: true,
      });
      if (resolved !== null && typeof resolved.id === "string" && isNodeModulesPath(resolved.id)) {
        return {
          external: true,
          id: normalizeEsmImportSpecifier(
            await captureCompileTimeExternalPackage({
              packageName: packageImportName(source),
              packageRoot: input.packageRoot,
              planProvider: input.captureExternalDependencyPlan,
              resolvedId: resolved.id,
            }),
          ),
        };
      }

      return undefined;
    },
  };
}

async function captureCompileTimeExternalPackage(input: {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly planProvider?: (input: {
    readonly packageName: string;
    readonly resolvedPackagePath: string;
  }) => Promise<CompiledExternalDependencyPlan>;
  readonly resolvedId: string;
}): Promise<string> {
  const plan =
    input.planProvider === undefined
      ? await createCompiledExternalDependencyCaptureFromPackagePath({
          packageName: input.packageName,
          resolvedPackagePath: input.resolvedId,
        })
      : await input.planProvider({
          packageName: input.packageName,
          resolvedPackagePath: input.resolvedId,
        });
  const entry = plan.entries[0]!;
  const rootPackage = entry.packages.find((pkg) => pkg.id === entry.rootPackageId)!;
  if (!isPathInsideOrEqual(input.resolvedId, rootPackage.resolvedPackageRoot)) {
    throw new Error(
      `Resolved external package import "${input.resolvedId}" escapes package "${input.packageName}".`,
    );
  }
  const materialized = await materializeCompiledExternalDependencyPlan({
    destinationRoot: join(
      input.packageRoot,
      "node_modules",
      ".cache",
      "eve",
      "authored-external-dependencies",
    ),
    plan,
  });
  const capturedRoot = materialized.entryPackageRoots.get(entry.id)!;
  return join(capturedRoot, relative(rootPackage.resolvedPackageRoot, input.resolvedId));
}

/**
 * Keeps package imports external in an extension distribution while enforcing
 * that every runtime package is declared by the extension.
 */
export function createDistributionPackageBoundaryPlugin(input: {
  readonly runtimeDependencies: readonly string[];
  readonly packageRoot: string;
}): Record<string, unknown> {
  const declaredDependencies = new Set(input.runtimeDependencies);

  return {
    name: "eve-extension-distribution-package-boundary",
    async resolveId(
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) {
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (source.startsWith("#")) {
        const resolved = await this.resolve(source, importer, {
          kind: options.kind,
          skipSelf: true,
        });
        if (
          resolved !== null &&
          typeof resolved.id === "string" &&
          !isPathInsideOrEqual(toCanonicalPath(resolved.id), toCanonicalPath(input.packageRoot))
        ) {
          const packageName = nearestPackageName(resolved.id);
          if (packageName !== undefined && !declaredDependencies.has(packageName)) {
            throw new Error(
              `Package import "${source}" resolves to undeclared package "${packageName}". ` +
                `Add "${packageName}" to dependencies, optionalDependencies, or peerDependencies.`,
            );
          }
        }
        return undefined;
      }

      if (isBuiltin(source)) {
        return { external: true, id: source };
      }

      const packageName = packageImportName(source);
      if (!declaredDependencies.has(packageName)) {
        throw new Error(
          `Package "${source}" is not declared by the extension. ` +
            `Add "${packageName}" to dependencies, optionalDependencies, or peerDependencies.`,
        );
      }

      let resolved = await this.resolve(source, importer, {
        kind: options.kind,
        skipSelf: true,
      });
      if (resolved === null) {
        resolved = await this.resolve(source, join(input.packageRoot, "package.json"), {
          kind: options.kind,
          skipSelf: true,
        });
      }
      if (resolved === null || typeof resolved.id !== "string") {
        throw new Error(
          `Cannot resolve declared package "${source}". Install the extension's dependencies before building.`,
        );
      }

      return { external: true, id: source };
    },
  };
}

export function normalizeExternalDependencies(
  externalDependencies: readonly string[] = [],
): string[] {
  // This is intentionally explicit-only. Nitro owns hosted dependency
  // classification; applying its trace set to authored generation bundles
  // would turn bundleable packages into a second dev-only packaging graph.
  return [...new Set(externalDependencies)].sort();
}

function packageImportName(source: string): string {
  return source.startsWith("@") ? source.split("/", 2).join("/") : source.split("/", 1)[0]!;
}

function nearestPackageName(filePath: string): string | undefined {
  let directory = dirname(toCanonicalPath(filePath));
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        return typeof manifest.name === "string" && manifest.name.length > 0
          ? manifest.name
          : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function isPackageImport(source: string): boolean {
  if (isPathImport(source)) {
    return false;
  }

  if (/^(?:node|data|file):/.test(source)) {
    return false;
  }

  if (source.startsWith("@/")) {
    return false;
  }

  return !source.startsWith(CACHED_CHANNEL_PREFIX);
}

export function isPathImport(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source);
}

function isFrameworkRuntimeImport(source: string, importer: string | undefined): boolean {
  if (source === "eve" || source.startsWith("eve/")) {
    return true;
  }

  // Workflow runtime imports in authored source must bind to the
  // process-shared workflow runtime. Third-party packages inlined into a
  // bundle keep their own copies instead: eve vendors `@workflow/*`, so a
  // bare transitive import (e.g. `@ai-sdk/provider-utils` → `@workflow/serde`)
  // is not resolvable from a materialized generation.
  if (source === "workflow" || source.startsWith("workflow/") || source.startsWith("@workflow/")) {
    return importer === undefined || !isNodeModulesPath(importer);
  }

  return false;
}

export function isNodeModulesPath(path: string): boolean {
  return path.replaceAll("\\", "/").includes("/node_modules/");
}

function toCanonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}
