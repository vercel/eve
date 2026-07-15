import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { assertNoWorkflowDirectivePrologue } from "#internal/authored-directive-prologue.js";
import { createAuthoredModuleBundleError } from "#internal/authored-module-bundle.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createFixedNamespaceScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import {
  CACHED_CHANNEL_PREFIX,
  RESOLVE_EXTENSIONS,
  createGenerationPackageBoundaryPlugin,
  createRuntimeLoaderPackageBoundaryPlugin,
  isNodeModulesPath,
  isPathImport,
  normalizeExternalDependencies,
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

const AUTHORED_BUNDLED_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH = join(
  "node_modules",
  ".cache",
  "eve",
  "authored-modules",
);
const CHANNEL_MODULE_CACHE_KEY = "__eveChannelModuleCache__";

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
 * Bundles one authored entry for immediate dev/eval loading. Package dependencies
 * remain external while relative authored source is inlined.
 */
export async function bundleAuthoredModuleCode(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  return await buildAuthoredModuleBundle(modulePath, options, {
    channelIdentity: true,
    packageBoundaryPlugin: createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot: resolveAuthoredPackageRoot(modulePath),
    }),
    plugins: [],
    sourcemap: "inline",
  });
}

/**
 * Bundles one authored entry for an immutable development generation. Ordinary
 * package dependencies are inlined so the emitted code stays executable after
 * the original workspace changes; framework runtime imports and explicitly
 * configured external dependencies keep their normal runtime resolution.
 */
export async function bundleAuthoredModuleForGeneration(
  modulePath: string,
  options: AuthoredModuleLoadOptions = {},
): Promise<string> {
  const code = await buildAuthoredModuleBundle(modulePath, options, {
    // Generation bundles must not reference process state: the channel
    // identity plugin emits reads of a process-global cache keyed by live
    // source paths, which an immutable retained artifact cannot depend on.
    channelIdentity: false,
    packageBoundaryPlugin: createGenerationPackageBoundaryPlugin({
      externalDependencies: normalizeExternalDependencies(options.externalDependencies),
      packageRoot: resolveAuthoredPackageRoot(modulePath),
    }),
    plugins: [createAuthoredDirectiveGuardPlugin()],
    sourcemap: false,
  });

  return removeRolldownModuleRegionComments(code);
}

async function buildAuthoredModuleBundle(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
  configuration: {
    readonly channelIdentity: boolean;
    readonly packageBoundaryPlugin: Record<string, unknown>;
    readonly plugins: readonly Record<string, unknown>[];
    readonly sourcemap: false | "inline";
  },
): Promise<string> {
  const channelCache = configuration.channelIdentity ? getChannelModuleCache() : undefined;
  const packageRoot = resolveAuthoredPackageRoot(modulePath);
  const tsconfigPath = resolveAuthoredTsConfigPath(packageRoot);
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
    ...configuration.plugins,
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
    configuration.packageBoundaryPlugin,
  ].filter((plugin) => plugin !== null);

  try {
    const chunk = await buildSingleRolldownChunk(`authored module for "${modulePath}"`, {
      cwd: packageRoot,
      input: modulePath,
      platform: "node",
      plugins,
      resolve: {
        extensions: [...RESOLVE_EXTENSIONS],
      },
      tsconfig: tsconfigPath,
      output: {
        comments: false,
        format: "esm",
        sourcemap: configuration.sourcemap,
      },
    });
    return chunk.code;
  } catch (error) {
    throw createAuthoredModuleBundleError(modulePath, error);
  }
}

function createAuthoredDirectiveGuardPlugin(): Record<string, unknown> {
  return {
    name: "eve-authored-directive-guard",
    async transform(source: string, id: string) {
      if (!AUTHORED_BUNDLED_MODULE_EXTENSION.test(id) || isNodeModulesPath(id)) {
        return undefined;
      }

      await assertNoWorkflowDirectivePrologue({ filePath: id, source });
      return undefined;
    },
  };
}

function removeRolldownModuleRegionComments(code: string): string {
  return code
    .split("\n")
    .filter((line) => !line.startsWith("//#region ") && line !== "//#endregion")
    .join("\n");
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

function createInFlightModuleLoadKey(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): string {
  const externalDependencies = normalizeExternalDependencies(options.externalDependencies);

  return `${modulePath}\0${externalDependencies.join("\0")}\0${options.extensionScopeNamespace ?? ""}`;
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
