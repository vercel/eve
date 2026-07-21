import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

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

interface ResolvedAuthoredExternalModule {
  readonly packageName: string;
  readonly resolvedId: string;
}

export function createGenerationPackageBoundaryPlugin(input: {
  readonly externalDependencies: readonly string[];
  readonly packageRoot: string;
}): Record<string, unknown> {
  return {
    name: "eve-generation-package-boundary",
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
        return {
          external: true,
          id: source,
        };
      }

      const externalModule = await resolveConfiguredExternalModule.call(this, {
        externalDependencies: input.externalDependencies,
        importer,
        kind: options.kind,
        packageRoot: input.packageRoot,
        source,
      });
      if (externalModule === undefined) {
        return undefined;
      }

      return { external: true, id: source };
    },
  };
}

export function createRuntimeLoaderPackageBoundaryPlugin(input: {
  readonly externalDependencies: readonly string[];
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

      const externalModule = await resolveConfiguredExternalModule.call(this, {
        externalDependencies: input.externalDependencies,
        importer,
        kind: options.kind,
        packageRoot: input.packageRoot,
        source,
      });
      if (externalModule !== undefined) {
        return {
          external: true,
          id:
            resolveExistingExternalFilePath(externalModule.resolvedId) ?? externalModule.resolvedId,
        };
      }

      const importerPath =
        importer === undefined ||
        importer.startsWith("\0") ||
        importer.startsWith(CACHED_CHANNEL_PREFIX)
          ? undefined
          : resolve(importer);

      // Keep package imports authored directly by the app external by
      // default, but let symlinked/file workspace packages compile as
      // source. Those packages often export `.ts` files and rely on the
      // bundler's extension resolution for their own relative imports.
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
            id: source,
          };
        }
      }

      return undefined;
    },
  };
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

async function resolveConfiguredExternalModule(
  this: RolldownResolveContext,
  input: {
    readonly externalDependencies: readonly string[];
    readonly importer: string | undefined;
    readonly kind: string;
    readonly packageRoot: string;
    readonly source: string;
  },
): Promise<ResolvedAuthoredExternalModule | undefined> {
  const packageName = resolveConfiguredExternalDependency(input.source, input.externalDependencies);
  if (packageName === undefined) {
    return undefined;
  }

  let resolved = await this.resolve(input.source, input.importer, {
    kind: input.kind,
    skipSelf: true,
  });
  if (resolved === null) {
    resolved = await this.resolve(input.source, join(input.packageRoot, "package.json"), {
      kind: input.kind,
      skipSelf: true,
    });
  }
  if (resolved === null || typeof resolved.id !== "string") {
    throw new Error(`Cannot resolve external package "${input.source}".`);
  }

  return { packageName, resolvedId: resolved.id };
}

export function normalizeExternalDependencies(
  externalDependencies: readonly string[] = [],
): string[] {
  // This is intentionally explicit-only. Nitro owns hosted dependency
  // classification; applying its trace set to authored generation bundles
  // would turn bundleable packages into a second dev-only packaging graph.
  return [...new Set(externalDependencies)].sort();
}

function resolveConfiguredExternalDependency(
  source: string,
  externalDependencies: readonly string[],
): string | undefined {
  return externalDependencies.find(
    (dependencyName) => source === dependencyName || source.startsWith(`${dependencyName}/`),
  );
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

function resolveExistingExternalFilePath(id: string): string | undefined {
  if (existsSync(id)) {
    return id;
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${id}${extension}`;

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
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
