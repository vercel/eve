import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import type { Plugin } from "rolldown";

import {
  findAuthoredPackageRoot,
  isAuthoredSourcePath,
} from "#internal/authored-package-boundary.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

const AUTHORED_ASSET_CODE_EXTENSIONS = [
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

// Supersets of isPotentialAuthoredAssetImport, so most imports skip the JS hook.
const RESOLVE_FILTER = /^(?:\.|\/|[A-Za-z]:[\\/])/;

/**
 * Creates the Rollup-compatible plugin that gives authored modules a small
 * asset-module surface for non-code relative imports. An asset may sit outside
 * the agent directory, but not outside the authored package or the package
 * that owns the importing module, such as a workspace package bundled from
 * source.
 */
export function createAuthoredAssetImportPlugin(input: {
  readonly packageRoot: string;
  /**
   * Handles only imports from importers outside `node_modules`: authored
   * source and workspace packages bundled from source. Their assets may still
   * sit in `node_modules`. Set it for bundles that also bundle dependencies,
   * such as the Nitro server and the workflow driver, so installed dependency
   * imports stay with the host bundler.
   */
  readonly authoredSourceOnly?: boolean;
  /** With `authoredSourceOnly`, installed modules to handle anyway. */
  readonly handlesInstalledModule?: (path: string) => boolean;
}): Plugin {
  const packageRoot = toCanonicalPath(input.packageRoot);
  // Built here rather than at module scope: runtime modules import this file.
  const loadFilter = [
    /\?raw$/,
    new RegExp(
      String.raw`\.(?!(?:${AUTHORED_ASSET_CODE_EXTENSIONS.map((extension) => extension.slice(1)).join("|")}|node)(?:[?#]|$))[^./?#]*(?:[?#].*)?$`,
    ),
  ];
  const handles = (path: string): boolean =>
    input.authoredSourceOnly !== true ||
    isAuthoredSourcePath(path) ||
    input.handlesInstalledModule?.(path) === true;
  // Ids resolved here for an authored importer, so `load` accepts them even inside `node_modules`.
  const resolvedAssetIds = new Set<string>();
  return {
    name: "eve-authored-asset-import",
    resolveId: {
      filter: { id: RESOLVE_FILTER },
      handler(source: string, importer: string | undefined) {
        if (
          !isPotentialAuthoredAssetImport(source) ||
          importer === undefined ||
          !handles(importer)
        ) {
          return undefined;
        }

        const { path, suffix } = splitImportSuffix(source);
        const resolvedPath = isAbsolute(path) ? path : resolve(dirname(importer), path);
        // A dotted code import, such as `./schema.v1` or a `./helpers.v2/` index, is no asset.
        if (!isFile(resolvedPath)) {
          return undefined;
        }
        const canonicalPath = toCanonicalPath(resolvedPath);
        const importerPackageRoot =
          findAuthoredPackageRoot(dirname(toCanonicalPath(importer))) ?? packageRoot;
        if (
          !isPathInsideOrEqual(canonicalPath, packageRoot) &&
          !isPathInsideOrEqual(canonicalPath, importerPackageRoot)
        ) {
          throw new Error(
            `Authored asset import "${source}" from "${importer}" resolves outside package root "${importerPackageRoot}".`,
          );
        }

        const id = `${canonicalPath}${suffix}`;
        resolvedAssetIds.add(id);
        return id;
      },
    },
    load: {
      filter: { id: loadFilter },
      async handler(id: string) {
        const { path, suffix } = splitImportSuffix(id);

        if (!isPotentialAuthoredAssetImport(id) || !(resolvedAssetIds.has(id) || handles(path))) {
          return undefined;
        }

        if (suffix === "?raw") {
          const source = await readAssetText(path);

          if (source === undefined) {
            return undefined;
          }

          return {
            code: `export default ${JSON.stringify(source)};`,
            moduleType: "js" as const,
          };
        }

        const dataUrl = await readAssetDataUrl(path);

        if (dataUrl === undefined) {
          return undefined;
        }

        return {
          code: `export default ${JSON.stringify(dataUrl)};`,
          moduleType: "js" as const,
        };
      },
    },
  };
}

/** Unreadable paths, such as one that is too long, fall through to the next resolver. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toCanonicalPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function readAssetText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isPotentialAuthoredAssetImport(source: string): boolean {
  if (
    source.startsWith("\0") ||
    source.startsWith("node:") ||
    source.startsWith("data:") ||
    source.startsWith("file:")
  ) {
    return false;
  }

  const { path, suffix } = splitImportSuffix(source);

  if (!path.startsWith(".") && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }

  // As in Vite, `?raw` imports any file as text, including code files and files without an extension.
  if (suffix === "?raw") {
    return true;
  }

  const extension = extname(path);

  return (
    extension.length > 0 &&
    extension !== ".node" &&
    !(AUTHORED_ASSET_CODE_EXTENSIONS as readonly string[]).includes(extension)
  );
}

function splitImportSuffix(specifier: string): { path: string; suffix: string } {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");
  const suffixIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  if (suffixIndex === -1) {
    return {
      path: specifier,
      suffix: "",
    };
  }

  return {
    path: specifier.slice(0, suffixIndex),
    suffix: specifier.slice(suffixIndex),
  };
}

async function readAssetDataUrl(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    return `data:${getAssetMimeType(path)};base64,${bytes.toString("base64")}`;
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return undefined;
    }

    throw error;
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

function getAssetMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".gif":
      return "image/gif";
    case ".html":
      return "text/html";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".wasm":
      return "application/wasm";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
