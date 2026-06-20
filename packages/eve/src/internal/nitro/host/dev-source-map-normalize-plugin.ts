import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Nitro } from "nitro/types";

import { readDevelopmentRuntimeSnapshotMetadataForPath } from "#internal/nitro/dev-runtime-snapshot-metadata.js";
import { isSourceMapUrl } from "#internal/source-map-path.js";

interface MutableSourceMap {
  ignoreList?: unknown;
  sources?: unknown;
  sourceRoot?: unknown;
  version: number;
}

interface NormalizedSourceMapSource {
  readonly authored: boolean;
  readonly source: string;
}

interface NormalizeDevelopmentSourceMapOptions {
  readonly appRoot?: string;
}

/**
 * Cleans up Nitro's final dev bundle sourcemap for Chrome DevTools.
 *
 * Nitro virtual ids are `#...` specifiers. If they stay relative in the final
 * map, Chrome resolves them as `file:///app/#...` and renders many duplicate
 * entries named after the app directory. Dev snapshots are also real runtime
 * files, but users want breakpoints in their live workspace files. This pass
 * moves virtual/generated runtime sources to Eve-owned URL schemes and rewrites
 * snapshot-authored sources back to live `file://` URLs.
 */
export function addDevelopmentSourceMapNormalizePlugin(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.push({
      name: "eve:dev-source-map-normalize",
      writeBundle(options, bundle) {
        if (options.dir === undefined) {
          return;
        }

        for (const item of Object.values(bundle)) {
          if (item.type !== "chunk") {
            continue;
          }

          const sourceMapPath = join(options.dir, `${item.fileName}.map`);
          if (!existsSync(sourceMapPath)) {
            continue;
          }

          normalizeDevelopmentSourceMapForDevTools(sourceMapPath, {
            appRoot: nitro.options.rootDir,
          });
        }
      },
    });
  });
}

export function normalizeDevelopmentSourceMapForDevTools(
  sourceMapPath: string,
  options: NormalizeDevelopmentSourceMapOptions = {},
): boolean {
  const map = JSON.parse(readFileSync(sourceMapPath, "utf8")) as MutableSourceMap;
  if (!Array.isArray(map.sources)) {
    return false;
  }

  const sourceMapDirectory = dirname(sourceMapPath);
  const appRoot = options.appRoot === undefined ? undefined : resolve(options.appRoot);
  const sourceRoot =
    typeof map.sourceRoot === "string" && map.sourceRoot.length > 0 ? map.sourceRoot : undefined;
  let changed = false;
  const normalizedSources = map.sources.map((source) => {
    if (typeof source !== "string") {
      return { authored: false, source: String(source) };
    }

    const normalized = normalizeDevSourceMapSource(sourceMapDirectory, source, appRoot, sourceRoot);
    if (normalized.source !== source) {
      changed = true;
    }
    return normalized;
  });
  const sources = normalizedSources.map((source) => source.source);
  // Only live authored files should stay prominent in DevTools; virtual ids,
  // framework/runtime files, and generated artifacts are useful but noisy.
  const ignoreList = appRoot === undefined ? [] : createDevToolsIgnoreList(normalizedSources);
  if (!numberArraysEqual(ignoreList, map.ignoreList)) {
    changed = true;
  }

  if (map.sourceRoot !== undefined) {
    changed = true;
  }

  if (!changed) {
    return false;
  }

  writeFileSync(
    sourceMapPath,
    `${JSON.stringify({
      ...map,
      ignoreList,
      sources,
      sourceRoot: undefined,
    })}\n`,
  );
  return true;
}

function normalizeDevSourceMapSource(
  sourceMapDirectory: string,
  source: string,
  appRoot: string | undefined,
  sourceRoot: string | undefined,
): NormalizedSourceMapSource {
  const virtualSource = normalizeVirtualSource(source);
  if (virtualSource !== undefined) {
    return { authored: false, source: virtualSource };
  }

  const resolvedSource = resolveSourceMapSource({
    source,
    sourceMapDirectory,
    sourceRoot,
  });
  if (resolvedSource.path === undefined) {
    return { authored: false, source: resolvedSource.source };
  }

  const sourcePath = resolvedSource.path;
  const metadata = readDevelopmentRuntimeSnapshotMetadataForPath(sourcePath);
  if (metadata === undefined) {
    return {
      authored: isAuthoredApplicationSourcePath(sourcePath, appRoot),
      source: resolvedSource.source,
    };
  }

  if (!isPathInsideOrEqual(sourcePath, metadata.snapshotSourceRoot)) {
    return {
      authored: isAuthoredApplicationSourcePath(sourcePath, appRoot),
      source: resolvedSource.source,
    };
  }

  // Generated runtime artifacts are useful context, but mapping them back into
  // the app's real `.eve` directory makes DevTools look like user source.
  if (isPathInsideOrEqual(sourcePath, join(metadata.runtimeAppRoot, ".eve"))) {
    return {
      authored: false,
      source: toEveRuntimeSourceUrl(relative(metadata.runtimeAppRoot, sourcePath)),
    };
  }

  const liveSourcePath = join(
    metadata.sourceRoot,
    relative(metadata.snapshotSourceRoot, sourcePath),
  );
  const authored = isAuthoredApplicationSourcePath(liveSourcePath, appRoot);

  if (!authored && appRoot !== undefined) {
    return {
      authored: false,
      source: toEveRuntimeSourceUrl(relative(metadata.snapshotSourceRoot, sourcePath)),
    };
  }

  return {
    authored,
    source: pathToFileURL(liveSourcePath).href,
  };
}

function resolveSourceMapSource(input: {
  readonly source: string;
  readonly sourceMapDirectory: string;
  readonly sourceRoot: string | undefined;
}): { readonly path?: string; readonly source: string } {
  const fileUrlSourcePath = parseFileUrlSourcePath(input.source);
  if (fileUrlSourcePath !== undefined) {
    return { path: fileUrlSourcePath, source: input.source };
  }

  if (isSourceMapUrl(input.source)) {
    return { source: input.source };
  }

  if (isAbsolute(input.source)) {
    return { path: input.source, source: input.source };
  }

  if (input.sourceRoot === undefined) {
    return {
      path: resolve(input.sourceMapDirectory, input.source),
      source: input.source,
    };
  }

  const sourceRootPath = parseFileUrlSourcePath(input.sourceRoot);
  if (sourceRootPath !== undefined) {
    const sourcePath = resolve(sourceRootPath, input.source);
    return { path: sourcePath, source: pathToFileURL(sourcePath).href };
  }

  if (isSourceMapUrl(input.sourceRoot)) {
    try {
      const baseUrl = input.sourceRoot.endsWith("/") ? input.sourceRoot : `${input.sourceRoot}/`;
      return { source: new URL(input.source, baseUrl).href };
    } catch {
      return { source: input.source };
    }
  }

  const sourcePath = resolve(
    isAbsolute(input.sourceRoot)
      ? input.sourceRoot
      : resolve(input.sourceMapDirectory, input.sourceRoot),
    input.source,
  );
  return { path: sourcePath, source: pathToFileURL(sourcePath).href };
}

function normalizeVirtualSource(source: string): string | undefined {
  const stripped = stripLeadingRelativeSourceSegments(source.replaceAll("\\", "/"));
  if (!stripped.startsWith("#")) {
    return undefined;
  }

  // Chrome resolves relative `#...` sources as app files; an Eve-owned scheme
  // keeps Nitro virtual modules out of the authored source tree.
  return toEveNitroSourceUrl(stripped.slice(1).trim());
}

function stripLeadingRelativeSourceSegments(source: string): string {
  let stripped = source;
  while (stripped.startsWith("./") || stripped.startsWith("../")) {
    stripped = stripped.startsWith("./") ? stripped.slice(2) : stripped.slice(3);
  }
  return stripped;
}

function toEveNitroSourceUrl(source: string): string {
  return `eve://nitro/${encodeSourcePath(source)}`;
}

function toEveRuntimeSourceUrl(source: string): string {
  return `eve://runtime/${encodeSourcePath(source)}`;
}

function encodeSourcePath(source: string): string {
  return source
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseFileUrlSourcePath(source: string): string | undefined {
  if (!source.startsWith("file://")) {
    return undefined;
  }

  try {
    return fileURLToPath(source);
  } catch {
    return undefined;
  }
}

function isAuthoredApplicationSourcePath(path: string, appRoot: string | undefined): boolean {
  if (appRoot === undefined || !isPathInsideOrEqual(path, appRoot)) {
    return false;
  }

  const relativePath = relative(appRoot, path);
  if (relativePath === "") {
    return false;
  }

  const parts = relativePath.split(/[\\/]/);
  return !parts.includes(".eve") && !parts.includes("node_modules");
}

function createDevToolsIgnoreList(sources: readonly NormalizedSourceMapSource[]): number[] {
  const ignoreList: number[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    if (!source.authored) {
      ignoreList.push(sourceIndex);
    }
  }
  return ignoreList;
}

function numberArraysEqual(left: readonly number[], right: unknown): boolean {
  if (!Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => right[index] === value);
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  );
}
