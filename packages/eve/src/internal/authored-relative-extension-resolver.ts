import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isNodeModulesPath, isPathImport } from "#internal/authored-package-boundary.js";

const PATH_IMPORT_FILTER = /^(?:\.|\/|[A-Za-z]:[\\/])/;

/**
 * Resolves extensionless path imports before Rolldown's default resolver.
 */
export function createAuthoredRelativeExtensionResolverPlugin(input: {
  readonly extensions: readonly string[];
}): Record<string, unknown> {
  const isFile = createCachedFileProbe();

  return {
    name: "eve-authored-relative-extension-resolver",
    resolveId: {
      filter: {
        id: PATH_IMPORT_FILTER,
      },
      handler(source: string, importer: string | undefined) {
        if (importer === undefined || importer.startsWith("\0") || !isPathImport(source)) {
          return undefined;
        }

        const candidate = isAbsolute(source) ? source : resolve(dirname(importer), source);
        const resolvedPath = resolveExistingImportPath(candidate, input.extensions, isFile);

        if (resolvedPath === undefined) {
          return undefined;
        }

        // Standard resolvers realpath resolved modules, so a module reached
        // through a node_modules symlink resolves its own dependencies from its
        // real location — with pnpm's store layout they are store siblings that
        // only exist there. Path imports probed here (the compiled module map
        // reaches store-installed extension source through the consumer's
        // node_modules symlink) must get the same treatment, and it keeps one
        // canonical module identity per real file.
        const id = isNodeModulesPath(resolvedPath) ? toRealModulePath(resolvedPath) : resolvedPath;
        // Rolldown applies package metadata such as `sideEffects: false` only
        // to ids tied to their package.json. Without it, a module reached both
        // here and through a package specifier would be tree-shaken or kept
        // depending on which import resolved first.
        const packageJsonPath = findPackageJsonPath(id, isFile);
        return packageJsonPath === undefined ? { id } : { id, packageJsonPath };
      },
    },
  };
}

function findPackageJsonPath(path: string, isFile: (path: string) => boolean): string | undefined {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const candidate = join(directory, "package.json");

    if (isFile(candidate)) {
      return candidate;
    }

    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

function createCachedFileProbe(): (path: string) => boolean {
  const cache = new Map<string, boolean>();

  return (path) => {
    const cached = cache.get(path);

    if (cached !== undefined) {
      return cached;
    }

    let result = false;

    try {
      result = statSync(path).isFile();
    } catch {
      // Missing and inaccessible paths both remain unresolved, as before.
    }

    cache.set(path, result);
    return result;
  };
}

function resolveExistingImportPath(
  path: string,
  extensions: readonly string[],
  isFile: (path: string) => boolean,
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

function toRealModulePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
