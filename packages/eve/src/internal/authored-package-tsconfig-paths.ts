import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "rolldown";

import { type ParseError, parse as parseJsonc } from "#compiled/jsonc-parser/index.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { isNodeModulesPath } from "#internal/authored-package-boundary.js";
import {
  exclude,
  type FilterExpression,
  id,
  importerId,
  include,
  packageModulesRegex,
} from "#internal/bundler/filters.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

type PackageTsConfigPaths = {
  readonly baseDirectory: string;
  readonly entries: readonly {
    readonly pattern: string;
    readonly targets: readonly string[];
  }[];
};

type FileStat = {
  isFile(): boolean;
};

type CachedStatProbe = (path: string) => Promise<FileStat | undefined>;

const NON_PACKAGE_IMPORT_FILTER = /^(?:\.|\/|[A-Za-z]:[\\/]|node:|data:|file:)/;
const packageTsConfigPathsCache = new Map<string, Promise<PackageTsConfigPaths | undefined>>();
const nearestPackageRootCache = new Map<string, Promise<string | undefined>>();

/**
 * Resolves tsconfig `paths` for authored source imported from linked
 * workspace packages. Rolldown handles the root app tsconfig; this only
 * fills the package-local config gap for sources outside the app root.
 */
export function createAuthoredPackageTsConfigPathsPlugin(input: {
  appPackageRoot: string;
  /** Leaves imports from installed dependencies to the bundler. */
  authoredSourceOnly?: boolean;
  extensions: readonly string[];
  /** With `authoredSourceOnly`, installed importers to handle anyway. */
  handlesInstalledModule?: (path: string) => boolean;
  /** With `authoredSourceOnly`, a hook filter that admits every importer the handler accepts. */
  importerFilter?: FilterExpression;
}): Plugin {
  const probeStat = createCachedStatProbe();
  // eve ships compiled JavaScript with no tsconfig `paths`, so its modules have nothing to
  // resolve here. A workspace-linked eve sits outside `node_modules`, where its package-private
  // imports would otherwise be most of this hook's calls.
  const eveModule =
    input.authoredSourceOnly === true
      ? packageModulesRegex(realpathSync.native(resolvePackageRoot()))
      : undefined;

  return {
    name: "eve-package-tsconfig-paths",
    resolveId: {
      filter:
        eveModule === undefined
          ? { id: { exclude: NON_PACKAGE_IMPORT_FILTER } }
          : [
              exclude(id(NON_PACKAGE_IMPORT_FILTER)),
              exclude(importerId(eveModule)),
              ...(input.importerFilter === undefined ? [] : [include(input.importerFilter)]),
            ],
      async handler(source, importer, options) {
        if (
          importer === undefined ||
          !isPackageImport(source) ||
          eveModule?.test(importer) === true ||
          (input.authoredSourceOnly === true &&
            isNodeModulesPath(importer) &&
            input.handlesInstalledModule?.(importer) !== true)
        ) {
          return undefined;
        }

        const importerPath = resolve(importer);

        if (isPathInsideOrEqual(importerPath, input.appPackageRoot)) {
          return undefined;
        }

        const packageRoot = await resolveNearestPackageRoot(importerPath, probeStat);

        if (packageRoot === undefined || isPathInsideOrEqual(packageRoot, input.appPackageRoot)) {
          return undefined;
        }

        const config = await loadPackageTsConfigPaths(packageRoot);

        if (config === undefined) {
          return undefined;
        }

        for (const candidate of createTsConfigPathCandidates(source, config)) {
          const resolved = await this.resolve(candidate, importer, {
            kind: options.kind,
            skipSelf: true,
          });

          if (resolved !== null) {
            return resolved;
          }

          const existingPath = await resolveExistingPath(candidate, input.extensions, probeStat);

          if (existingPath !== undefined) {
            return { id: existingPath };
          }
        }

        return undefined;
      },
    },
  };
}

function loadPackageTsConfigPaths(packageRoot: string): Promise<PackageTsConfigPaths | undefined> {
  const cached = packageTsConfigPathsCache.get(packageRoot);

  if (cached !== undefined) {
    return cached;
  }

  const promise = readPackageTsConfigPaths(packageRoot);
  packageTsConfigPathsCache.set(packageRoot, promise);
  return promise;
}

async function readPackageTsConfigPaths(
  packageRoot: string,
): Promise<PackageTsConfigPaths | undefined> {
  const configFile = await readPackageConfig(packageRoot);

  if (configFile === undefined) {
    return undefined;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(configFile.source, errors, {
    allowTrailingComma: true,
  });

  if (errors.length > 0 || !isObjectRecord(parsed)) {
    return undefined;
  }

  const compilerOptions = parsed.compilerOptions;

  if (!isObjectRecord(compilerOptions) || !isObjectRecord(compilerOptions.paths)) {
    return undefined;
  }

  const configDirectory = dirname(configFile.path);
  const baseDirectory =
    typeof compilerOptions.baseUrl === "string"
      ? resolve(configDirectory, compilerOptions.baseUrl)
      : configDirectory;
  const entries = Object.entries(compilerOptions.paths)
    .flatMap(([pattern, targets]) => {
      if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string")) {
        return [];
      }

      return [{ pattern, targets }];
    })
    .sort((left, right) => right.pattern.length - left.pattern.length);

  if (entries.length === 0) {
    return undefined;
  }

  return { baseDirectory, entries };
}

async function readPackageConfig(
  packageRoot: string,
): Promise<{ path: string; source: string } | undefined> {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = join(packageRoot, fileName);

    try {
      return {
        path: configPath,
        source: await readFile(configPath, "utf8"),
      };
    } catch (error) {
      if (!isPathNotFoundError(error)) {
        throw error;
      }
    }
  }

  return undefined;
}

function createTsConfigPathCandidates(source: string, config: PackageTsConfigPaths): string[] {
  const candidates: string[] = [];

  for (const entry of config.entries) {
    const match = matchTsConfigPathPattern(source, entry.pattern);

    if (match === undefined) {
      continue;
    }

    for (const target of entry.targets) {
      const targetPath = target.includes("*") ? target.replaceAll("*", match) : target;
      candidates.push(resolve(config.baseDirectory, targetPath));
    }
  }

  return candidates;
}

function matchTsConfigPathPattern(source: string, pattern: string): string | undefined {
  const wildcardIndex = pattern.indexOf("*");

  if (wildcardIndex === -1) {
    return source === pattern ? "" : undefined;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return undefined;
  }

  return source.slice(prefix.length, source.length - suffix.length);
}

async function resolveExistingPath(
  path: string,
  extensions: readonly string[],
  probeStat: CachedStatProbe,
): Promise<string | undefined> {
  if (await existsAsFile(path, probeStat)) {
    return path;
  }

  for (const extension of extensions) {
    const candidate = `${path}${extension}`;

    if (await existsAsFile(candidate, probeStat)) {
      return candidate;
    }
  }

  for (const extension of extensions) {
    const candidate = join(path, `index${extension}`);

    if (await existsAsFile(candidate, probeStat)) {
      return candidate;
    }
  }

  return undefined;
}

async function existsAsFile(path: string, probeStat: CachedStatProbe): Promise<boolean> {
  return (await probeStat(path))?.isFile() ?? false;
}

function resolveNearestPackageRoot(
  path: string,
  probeStat: CachedStatProbe,
): Promise<string | undefined> {
  const startDirectory = dirname(path);
  const cached = nearestPackageRootCache.get(startDirectory);

  if (cached !== undefined) {
    return cached;
  }

  const promise = findNearestPackageRoot(startDirectory, probeStat);
  nearestPackageRootCache.set(startDirectory, promise);
  return promise;
}

async function findNearestPackageRoot(
  startDirectory: string,
  probeStat: CachedStatProbe,
): Promise<string | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    if (await pathExists(join(currentDirectory, "package.json"), probeStat)) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

async function pathExists(path: string, probeStat: CachedStatProbe): Promise<boolean> {
  return (await probeStat(path)) !== undefined;
}

function createCachedStatProbe(): CachedStatProbe {
  const cache = new Map<string, Promise<FileStat | undefined>>();

  return (path) => {
    const cached = cache.get(path);

    if (cached !== undefined) {
      return cached;
    }

    const result = stat(path).catch(() => undefined);
    cache.set(path, result);
    return result;
  };
}

function isPathNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isPackageImport(source: string): boolean {
  if (source.startsWith(".") || source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) {
    return false;
  }

  return !/^(?:node|data|file):/.test(source);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
