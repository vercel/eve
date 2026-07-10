import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { createAuthoredModuleBundleError } from "#internal/authored-module-bundle.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createFixedNamespaceScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import {
  buildWithNitroRolldown,
  getSingleRolldownChunk,
} from "#internal/bundler/nitro-rolldown.js";
import { SERVER_EXTERNAL_PACKAGES } from "#internal/nitro/host/server-external-packages.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

const AUTHORED_BUNDLED_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH = join(
  "node_modules",
  ".cache",
  "eve",
  "authored-modules",
);
const RESOLVE_EXTENSIONS = [
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

const CHANNEL_MODULE_CACHE_KEY = "__eveChannelModuleCache__";
const CACHED_CHANNEL_PREFIX = "eve-cached-channel:";

type RolldownResolveResult = {
  readonly id: string;
};

type RolldownResolveContext = {
  resolve(
    source: string,
    importer: string | undefined,
    options: { kind: string; skipSelf: boolean },
  ): Promise<RolldownResolveResult | null>;
};

export interface AuthoredModuleLoadOptions {
  readonly externalDependencies?: readonly string[];
  /**
   * When set, the module being loaded is extension-owned: its
   * `defineState`/`defineExtension` calls (and those of its same-package
   * dependencies bundled with it) are scoped to this namespace at bundle time.
   */
  readonly extensionScopeNamespace?: string;
}

function getChannelModuleCache(): Map<string, unknown> | undefined {
  return (globalThis as Record<string, unknown>)[CHANNEL_MODULE_CACHE_KEY] as
    | Map<string, unknown>
    | undefined;
}

/**
 * In-flight load deduplication map keyed by the absolute module path.
 *
 * The compiler walks every authored slot concurrently
 * (`compileChannelDefinition` and `buildChannelRouteIdentityMap` both
 * load the same channel module via `Promise.all`), so the same module
 * path is frequently loaded twice in parallel. Without dedup, both
 * callers race the bundler write/import pipeline against the
 * same `node_modules/.cache/.../<hash>.mjs` file: one call's
 * `writeFile` can truncate the bundle while another's `import()` is
 * still resolving it, surfacing as intermittent
 * "Expected … to match the public eve shape" failures during
 * compilation.
 *
 * The map only holds in-flight promises; once a load settles the entry
 * is cleared so subsequent compiles (e.g. a dev-server reload after
 * the author edits a file) re-run the bundle pipeline against the
 * fresh source. Node's ESM cache then dedupes by content-hashed URL for
 * unchanged files. The companion "skip write when the cache file already
 * exists" check inside {@link loadBundledAuthoredModule} eliminates the
 * write/read race even when two non-concurrent compile passes overlap on
 * the same hashed bundle path.
 */
const inFlightModuleLoads = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Loads one authored module namespace from disk during compile-time
 * discovery. Concurrent loads of the same `modulePath` share a single
 * Promise so the underlying bundle/import pipeline runs once.
 */
export function loadAuthoredModuleNamespace(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<Record<string, unknown>> {
  const cacheKey = resolve(modulePath);
  const inFlightKey = createInFlightModuleLoadKey(cacheKey, options);
  const inFlight = inFlightModuleLoads.get(inFlightKey);

  if (inFlight !== undefined) {
    return inFlight;
  }

  const loadPromise = (async () => {
    try {
      return await doLoadAuthoredModuleNamespace(modulePath, options);
    } finally {
      inFlightModuleLoads.delete(inFlightKey);
    }
  })();
  inFlightModuleLoads.set(inFlightKey, loadPromise);
  return loadPromise;
}

async function doLoadAuthoredModuleNamespace(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<Record<string, unknown>> {
  const loadedModule = AUTHORED_BUNDLED_MODULE_EXTENSION.test(modulePath)
    ? await loadBundledAuthoredModule(modulePath, options)
    : await import(createFileImportSpecifier(modulePath));

  return expectObjectRecord(
    loadedModule,
    `Expected "${modulePath}" to export a module namespace object.`,
  );
}

function createFileImportSpecifier(modulePath: string): string {
  const normalizedPath = modulePath.replaceAll("\\", "/");

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `file:///${encodeURI(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeURI(normalizedPath)}`;
  }

  return normalizedPath;
}

/**
 * Bundles one authored entry module to a self-contained ESM string using the
 * same plugin stack the dev/eval loader uses: `eve/*` and node_modules deps stay
 * external, relative source is inlined, and (when `extensionScopeNamespace` is
 * set) `defineState`/`defineExtension` are scoped to that namespace. Shared with
 * `eve build`'s extension entrypoint compilation so both paths bundle identically.
 */
export async function bundleAuthoredModuleCode(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const channelCache = getChannelModuleCache();
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  const tsconfigPath = resolveAuthoredTsConfigPath(packageRoot);
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);
  const channelIdentityPlugin =
    channelCache && channelCache.size > 0
      ? {
          name: "eve-channel-identity",
          async resolveId(
            this: RolldownResolveContext,
            source: string,
            importer: string | undefined,
            options: { kind: string },
          ) {
            if (!/channels[/\\]/.test(source) || options.kind !== "import-statement") {
              return undefined;
            }

            const resolved = await this.resolve(source, importer, {
              kind: options.kind,
              skipSelf: true,
            });

            if (resolved === null || typeof resolved.id !== "string") {
              return undefined;
            }

            const resolvedPath = resolve(resolved.id);

            if (!channelCache.has(resolvedPath)) {
              return undefined;
            }

            return { id: `${CACHED_CHANNEL_PREFIX}${resolvedPath}` };
          },
          load(id: string) {
            if (!id.startsWith(CACHED_CHANNEL_PREFIX)) {
              return undefined;
            }

            const cachedPath = id.slice(CACHED_CHANNEL_PREFIX.length);
            return {
              code: [
                `const cache = globalThis["${CHANNEL_MODULE_CACHE_KEY}"];`,
                `export default cache.get(${JSON.stringify(cachedPath)});`,
              ].join("\n"),
              moduleType: "js" as const,
            };
          },
        }
      : null;
  const plugins = [
    channelIdentityPlugin,
    options.extensionScopeNamespace === undefined
      ? null
      : createFixedNamespaceScopePlugin(options.extensionScopeNamespace),
    createAuthoredRelativeExtensionResolverPlugin({ extensions: RESOLVE_EXTENSIONS }),
    createAuthoredAssetImportPlugin(),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: packageRoot,
      extensions: RESOLVE_EXTENSIONS,
    }),
    createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    createPackageBoundaryPlugin(packageRoot, externalDependencies),
  ].filter((plugin) => plugin !== null);

  try {
    const result = await buildWithNitroRolldown({
      cwd: packageRoot,
      input: modulePath,
      platform: "node",
      plugins,
      resolve: {
        extensions: [...RESOLVE_EXTENSIONS],
      },
      tsconfig: tsconfigPath,
      write: false,
      output: {
        comments: false,
        format: "esm",
        sourcemap: "inline",
      },
    });
    return getSingleRolldownChunk(result, `authored module for "${modulePath}"`).code;
  } catch (error) {
    throw createAuthoredModuleBundleError(modulePath, error);
  }
}

async function loadBundledAuthoredModule(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Promise<unknown> {
  const code = await bundleAuthoredModuleCode(modulePath, options);
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);

  const bundleHash = createHash("sha1")
    .update(modulePath)
    .update("\0")
    .update(externalDependencies.join("\0"))
    .update("\0")
    .update(options.extensionScopeNamespace ?? "")
    .update("\0")
    .update(code)
    .digest("hex");
  const bundleDirectoryPath = join(
    resolveAuthoredPackageRoot(modulePath),
    AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH,
  );
  const bundlePath = join(bundleDirectoryPath, `${bundleHash}.mjs`);

  if (!existsSync(bundlePath)) {
    mkdirSync(bundleDirectoryPath, { recursive: true });
    writeFileSync(bundlePath, code);
  }

  return await import(`${createFileImportSpecifier(bundlePath)}?v=${bundleHash}`);
}

function createAuthoredRelativeExtensionResolverPlugin(input: {
  readonly extensions: readonly string[];
}): Record<string, unknown> {
  return {
    name: "eve-authored-relative-extension-resolver",
    resolveId(source: string, importer: string | undefined) {
      if (
        importer === undefined ||
        importer.startsWith("\0") ||
        importer.startsWith(CACHED_CHANNEL_PREFIX) ||
        !isPathImport(source)
      ) {
        return undefined;
      }

      const candidate = isAbsolute(source) ? source : resolve(dirname(importer), source);
      const resolvedPath = resolveExistingImportPath(candidate, input.extensions);

      if (resolvedPath === undefined) {
        return undefined;
      }

      return { id: resolvedPath };
    },
  };
}

function createPackageBoundaryPlugin(
  packageRoot: string,
  externalDependencies: readonly string[],
): Record<string, unknown> {
  // The bundler reports importers by realpath while `packageRoot` keeps the
  // caller's spelling (e.g. macOS `/var` vs `/private/var`); compare
  // canonical paths or the app-authored branch is skipped silently.
  const canonicalPackageRoot = toCanonicalPath(packageRoot);

  return {
    name: "eve-package-boundary",
    async resolveId(
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) {
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (isEveFrameworkImport(source)) {
        return {
          external: true,
          id: source,
        };
      }

      const configuredExternalDependency = resolveConfiguredExternalDependency(
        source,
        externalDependencies,
      );

      if (configuredExternalDependency !== undefined) {
        if (source !== configuredExternalDependency) {
          const resolved = await this.resolve(source, importer, {
            kind: options.kind,
            skipSelf: true,
          });

          if (resolved !== null && typeof resolved.id === "string") {
            return {
              external: true,
              id: resolveExternalFilePath({
                importer,
                packageRoot,
                resolvedId: resolved.id,
                source,
              }),
            };
          }

          const resolvedSubpath = resolveExternalFilePath({
            importer,
            packageRoot,
            source,
          });

          if (resolvedSubpath !== undefined) {
            return {
              external: true,
              id: resolvedSubpath,
            };
          }
        }

        return {
          external: true,
          id: source,
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

function createInFlightModuleLoadKey(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): string {
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);

  return `${modulePath}\0${externalDependencies.join("\0")}\0${options.extensionScopeNamespace ?? ""}`;
}

function normalizeExternalDependencies(externalDependencies: readonly string[] = []): string[] {
  return [...new Set([...SERVER_EXTERNAL_PACKAGES, ...externalDependencies])].sort();
}

function resolveConfiguredExternalDependency(
  source: string,
  externalDependencies: readonly string[],
): string | undefined {
  return externalDependencies.find(
    (dependencyName) => source === dependencyName || source.startsWith(`${dependencyName}/`),
  );
}

function resolveExternalFilePath(input: {
  importer: string | undefined;
  packageRoot: string;
  resolvedId?: string;
  source: string;
}): string | undefined {
  if (input.resolvedId !== undefined) {
    const resolvedPath = resolveExistingExternalFilePath(input.resolvedId);

    if (resolvedPath !== undefined) {
      return resolvedPath;
    }
  }

  const importerPath = normalizeImporterPath(input.importer);

  if (importerPath !== undefined) {
    try {
      return createRequire(importerPath).resolve(input.source);
    } catch {
      // Fall back to the app package root below.
    }
  }

  try {
    return createRequire(join(input.packageRoot, "package.json")).resolve(input.source);
  } catch {
    return input.resolvedId;
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

function resolveExistingImportPath(
  path: string,
  extensions: readonly string[],
): string | undefined {
  if (isFile(path)) {
    return path;
  }

  for (const extension of extensions) {
    const candidate = `${path}${extension}`;

    if (isFile(candidate)) {
      return candidate;
    }
  }

  for (const extension of extensions) {
    const candidate = join(path, `index${extension}`);

    if (isFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function normalizeImporterPath(importer: string | undefined): string | undefined {
  if (
    importer === undefined ||
    importer.startsWith("\0") ||
    importer.startsWith(CACHED_CHANNEL_PREFIX)
  ) {
    return undefined;
  }

  return resolve(importer);
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

function isPathImport(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source);
}

function isEveFrameworkImport(source: string): boolean {
  return source === "eve" || source.startsWith("eve/");
}

function isNodeModulesPath(path: string): boolean {
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

function resolveAuthoredTsConfigPath(packageRoot: string): string | false {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(packageRoot, fileName);
    if (existsSync(path)) {
      return path;
    }
  }

  return false;
}

function resolveAuthoredPackageRoot(modulePath: string): string {
  let currentDirectory = dirname(modulePath);

  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(`Failed to resolve the authored package root for "${modulePath}".`);
    }

    currentDirectory = parentDirectory;
  }
}
