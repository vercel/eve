import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

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

/**
 * Creates the Rollup-compatible plugin that gives authored modules a small
 * asset-module surface for non-code relative imports.
 */
export function createAuthoredAssetImportPlugin(): Record<string, unknown> {
  return {
    name: "eve-authored-asset-import",
    resolveId(source: string, importer: string | undefined) {
      if (!isPotentialAuthoredAssetImport(source) || importer === undefined) {
        return undefined;
      }

      const { path, suffix } = splitImportSuffix(source);
      const resolvedPath = isAbsolute(path) ? path : resolve(dirname(importer), path);

      return `${resolvedPath}${suffix}`;
    },
    async load(id: string) {
      const { path, suffix } = splitImportSuffix(id);

      if (!isPotentialAuthoredAssetImport(path)) {
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
  };
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

  const { path } = splitImportSuffix(source);

  if (!path.startsWith(".") && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    return false;
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
