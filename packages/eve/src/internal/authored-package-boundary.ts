import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImportKind, Plugin, PluginContext } from "rolldown";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageDependencyPath,
  resolvePackageRoot,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { matchesHostTracedDependency } from "#internal/host-traced-dependencies.js";
import {
  type InstalledPackage,
  installedDependencyClosure,
  installedPackageRoot,
} from "#internal/installed-packages.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

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

interface ResolvedAuthoredExternalModule {
  readonly packageName: string;
  readonly resolvedId: string;
}

export interface GenerationHostBundle {
  readonly tracedDependencies: readonly string[];
  readonly externalPackageRoots: Set<string>;
}

export function createGenerationPackageBoundaryPlugin(input: {
  readonly externalDependencies: readonly string[];
  readonly packageRoot: string;
  readonly extensionSpecifiers?: ReadonlySet<string>;
  readonly resolveExternalPaths?: boolean;
  readonly hostBundle?: GenerationHostBundle;
}): Plugin {
  const dependencyClosures = new Map<string, readonly InstalledPackage[]>();
  return {
    name: "eve-generation-package-boundary",
    async resolveId(source, importer, options) {
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (input.extensionSpecifiers?.has(source)) return undefined;
      if (isFrameworkRuntimeImport(source, importer)) {
        if (input.extensionSpecifiers?.has(source)) return undefined;
        return {
          external: true,
          id: toExternalModuleId(resolveFrameworkRuntimeImport(source), options.kind),
        };
      }

      if (source.startsWith("#")) {
        const resolvedPackageImport = resolvePackageImport(source, importer, input.packageRoot);
        if (resolvedPackageImport !== undefined) {
          return { id: resolvedPackageImport };
        }
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
          id: input.resolveExternalPaths
            ? toExternalModuleId(
                normalizeEsmImportSpecifier(externalModule.resolvedId),
                options.kind,
              )
            : source,
        };
      }

      if (input.hostBundle === undefined) return undefined;
      const resolved = await this.resolve(source, importer, {
        kind: options.kind,
        skipSelf: true,
      });
      if (
        resolved !== null &&
        typeof resolved.id === "string" &&
        !resolved.id.startsWith("\0") &&
        isNodeModulesPath(resolved.id) &&
        !isFrameworkPackagePath(resolved.id) &&
        canHostBundleInstalledPackage(
          resolved.id,
          input.hostBundle.tracedDependencies,
          dependencyClosures,
        )
      ) {
        const packageRoot = installedPackageRoot(resolved.id);
        if (packageRoot !== undefined) input.hostBundle.externalPackageRoots.add(packageRoot);
        return {
          external: true,
          id: toExternalModuleId(normalizeEsmImportSpecifier(resolved.id), options.kind),
        };
      }

      return undefined;
    },
  };
}

export function createRuntimeLoaderPackageBoundaryPlugin(input: {
  readonly externalDependencies: readonly string[];
  readonly packageRoot: string;
  readonly extensionSpecifiers?: ReadonlySet<string>;
}): Plugin {
  const canonicalPackageRoot = toCanonicalPath(input.packageRoot);

  return {
    name: "eve-runtime-loader-package-boundary",
    async resolveId(source, importer, options) {
      if (isRuntimeSchemeImport(source) && !/^(?:data|file):/i.test(source)) {
        return { external: true, id: source };
      }
      if (!isPackageImport(source)) {
        return undefined;
      }

      if (input.extensionSpecifiers?.has(source) === true) return undefined;
      if (isFrameworkRuntimeImport(source, importer)) {
        return {
          external: true,
          id: toExternalModuleId(resolveRuntimeLoaderFrameworkImport(source), options.kind),
        };
      }

      if (source.startsWith("#")) {
        const resolvedPackageImport = resolvePackageImport(source, importer, input.packageRoot);
        if (resolvedPackageImport !== undefined) {
          return isFrameworkPackagePath(resolvedPackageImport)
            ? {
                external: true,
                id: toExternalModuleId(
                  normalizeEsmImportSpecifier(resolvedPackageImport),
                  options.kind,
                ),
              }
            : { id: resolvedPackageImport };
        }
      }

      const externalModule = await resolveConfiguredExternalModule.call(this, {
        externalDependencies: input.externalDependencies,
        importer,
        kind: options.kind,
        packageRoot: input.packageRoot,
        source,
      });
      if (externalModule !== undefined) {
        const resolvedId =
          resolveExistingExternalFilePath(externalModule.resolvedId) ?? externalModule.resolvedId;

        return {
          external: true,
          id: toExternalModuleId(normalizeEsmImportSpecifier(resolvedId), options.kind),
        };
      }

      const importerPath =
        importer === undefined || importer.startsWith("\0") ? undefined : resolve(importer);

      if (
        importerPath !== undefined &&
        isPathInsideOrEqual(toCanonicalPath(importerPath), canonicalPackageRoot)
      ) {
        const resolved = await this.resolve(source, importer, {
          kind: options.kind,
          skipSelf: true,
        });

        if (resolved === null || typeof resolved.id !== "string") {
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

export function createDistributionPackageBoundaryPlugin(input: {
  readonly runtimeDependencies: readonly string[];
  readonly packageRoot: string;
}): Plugin {
  const declaredDependencies = new Set(input.runtimeDependencies);

  return {
    name: "eve-extension-distribution-package-boundary",
    async resolveId(source, importer, options) {
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
  this: PluginContext,
  input: {
    readonly externalDependencies: readonly string[];
    readonly importer: string | undefined;
    readonly kind: ImportKind;
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
  return [...new Set(externalDependencies)].sort();
}

export function resolveConfiguredExternalDependency(
  source: string,
  externalDependencies: readonly string[],
): string | undefined {
  return externalDependencies.find(
    (dependencyName) => source === dependencyName || source.startsWith(`${dependencyName}/`),
  );
}

export function packageImportName(source: string): string {
  return source.startsWith("@") ? source.split("/", 2).join("/") : source.split("/", 1)[0]!;
}

function nearestPackageName(filePath: string): string | undefined {
  const packageRoot = nearestPackageRoot(filePath);
  if (packageRoot === undefined) return undefined;

  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof manifest.name === "string" && manifest.name.length > 0
      ? manifest.name
      : undefined;
  } catch {
    return undefined;
  }
}

function canHostBundleInstalledPackage(
  resolvedId: string,
  tracedDependencies: readonly string[],
  dependencyClosures: Map<string, readonly InstalledPackage[]>,
): boolean {
  const packageRoot = installedPackageRoot(resolvedId);
  if (packageRoot === undefined) return false;
  if (tracedDependencies.length === 0) return true;
  let closure = dependencyClosures.get(packageRoot);
  if (closure === undefined) {
    closure = installedDependencyClosure([packageRoot]);
    dependencyClosures.set(packageRoot, closure);
  }
  return closure.every(
    (installed) =>
      installed.name === undefined ||
      !matchesHostTracedDependency(installed.name, tracedDependencies),
  );
}

function nearestPackageRoot(filePath: string): string | undefined {
  let directory = dirname(toCanonicalPath(filePath));
  while (true) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolvePackageImport(
  source: string,
  importer: string | undefined,
  fallbackPackageRoot: string,
): string | undefined {
  const packageRoot =
    importer === undefined || importer.startsWith("\0")
      ? fallbackPackageRoot
      : (nearestPackageRoot(importer) ?? fallbackPackageRoot);
  try {
    const resolved = createRequire(join(packageRoot, "package.json")).resolve(source);
    return isPathInsideOrEqual(toCanonicalPath(resolved), toCanonicalPath(packageRoot))
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

let canonicalFrameworkPackageRoot: string | undefined;

function isFrameworkPackagePath(path: string): boolean {
  canonicalFrameworkPackageRoot ??= toCanonicalPath(resolvePackageRoot());
  return nearestPackageRoot(path) === canonicalFrameworkPackageRoot;
}

function toExternalModuleId(id: string, kind: string): string {
  return kind === "require-call" && id.startsWith("file:") ? fileURLToPath(id) : id;
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

function isRuntimeSchemeImport(source: string): boolean {
  return !isPathImport(source) && /^[a-z][a-z0-9+.-]*:/i.test(source);
}

function isPackageImport(source: string): boolean {
  if (isPathImport(source)) {
    return false;
  }

  if (isRuntimeSchemeImport(source)) {
    return false;
  }

  return !source.startsWith("@/");
}

export function isPathImport(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source);
}

const SELF_MODIFICATION_MOUNT_SPECIFIERS = new Set([
  "eve/self-modification",
  "eve/extensions/self-modification/local",
  "eve/extensions/self-modification/remote",
]);

function isFrameworkRuntimeImport(source: string, importer: string | undefined): boolean {
  if (SELF_MODIFICATION_MOUNT_SPECIFIERS.has(source)) return false;
  if (source === "eve" || source.startsWith("eve/")) {
    return true;
  }

  if (source === "workflow" || source.startsWith("workflow/") || source.startsWith("@workflow/")) {
    return importer === undefined || !isNodeModulesPath(importer);
  }

  return false;
}

function resolveFrameworkRuntimeImport(source: string): string {
  if (source === "eve" || source.startsWith("eve/")) {
    return source;
  }
  return normalizeEsmImportSpecifier(resolveWorkflowModulePath(source));
}

function resolveRuntimeLoaderFrameworkImport(source: string): string {
  if (source === "eve" || source.startsWith("eve/")) {
    return normalizeEsmImportSpecifier(resolvePackageDependencyPath(source));
  }
  return resolveFrameworkRuntimeImport(source);
}

export function isNodeModulesPath(path: string): boolean {
  return path.replaceAll("\\", "/").includes("/node_modules/");
}

export function isAuthoredSourcePath(path: string): boolean {
  return isAbsolute(path) && !isNodeModulesPath(path);
}

export function resolveAuthoredPackageRoot(modulePath: string): string {
  const packageRoot = findAuthoredPackageRoot(dirname(modulePath));
  if (packageRoot === undefined) {
    throw new Error(`Failed to resolve the authored package root for "${modulePath}".`);
  }
  return packageRoot;
}

export function findAuthoredPackageRoot(directory: string): string | undefined {
  let currentDirectory = directory;

  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return realpathSync(currentDirectory);
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function toCanonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
