import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type ParseError, parse as parseJsonc } from "#compiled/jsonc-parser/index.js";

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

type PackageTsConfigPaths = {
  readonly baseDirectory: string;
  readonly entries: readonly {
    readonly pattern: string;
    readonly targets: readonly string[];
  }[];
};

const packageTsConfigPathsCache = new Map<string, Promise<PackageTsConfigPaths | undefined>>();
const nearestPackageRootCache = new Map<string, Promise<string | undefined>>();

/**
 * Resolves tsconfig `paths` for authored source imported from linked
 * workspace packages. Rolldown handles the root app tsconfig; this only
 * fills the package-local config gap for sources outside the app root.
 */
export function createAuthoredPackageTsConfigPathsPlugin(input: {
  appPackageRoot: string;
  extensions: readonly string[];
}): Record<string, unknown> {
  return {
    name: "eve-package-tsconfig-paths",
    async resolveId(
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) {
      if (importer === undefined || !isPackageImport(source)) {
        return undefined;
      }

      const importerPath = resolve(importer);

      if (isPathInsideOrEqual(importerPath, input.appPackageRoot)) {
        return undefined;
      }

      const packageRoot = await resolveNearestPackageRoot(importerPath);

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

        const existingPath = await resolveExistingPath(candidate, input.extensions);

        if (existingPath !== undefined) {
          return { id: existingPath };
        }
      }

      return undefined;
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
): Promise<string | undefined> {
  if (await existsAsFile(path)) {
    return path;
  }

  for (const extension of extensions) {
    const candidate = `${path}${extension}`;

    if (await existsAsFile(candidate)) {
      return candidate;
    }
  }

  for (const extension of extensions) {
    const candidate = join(path, `index${extension}`);

    if (await existsAsFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function existsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function resolveNearestPackageRoot(path: string): Promise<string | undefined> {
  const startDirectory = dirname(path);
  const cached = nearestPackageRootCache.get(startDirectory);

  if (cached !== undefined) {
    return cached;
  }

  const promise = findNearestPackageRoot(startDirectory);
  nearestPackageRootCache.set(startDirectory, promise);
  return promise;
}

async function findNearestPackageRoot(startDirectory: string): Promise<string | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    if (await pathExists(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}
