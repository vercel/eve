import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readDevelopmentRuntimeSnapshotMetadataForPath,
  type DevelopmentRuntimeArtifactsSnapshotMetadata,
} from "#internal/nitro/dev-runtime-snapshot-metadata.js";
import { buildNodeEsmCompatBanner } from "#internal/node-esm-compat-banner.js";
import { isSourceMapUrl } from "#internal/source-map-path.js";

const INLINE_SOURCE_MAP_PATTERN =
  /(\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,)([A-Za-z0-9+/=]+)(\s*)$/u;

export function prependNodeEsmCompatBannerToInlineSourceMap(input: {
  readonly code: string;
  readonly includeRequire: boolean;
}): string {
  const banner = buildNodeEsmCompatBanner(input.code, { includeRequire: input.includeRequire });
  if (banner === "") {
    return input.code;
  }

  const decoded = decodeInlineSourceMap(input.code);
  if (decoded === undefined) {
    return `${banner}\n${input.code}`;
  }

  // The compatibility banner adds generated lines before the authored bundle.
  // Pad the map with empty generated lines so existing original-line mappings
  // still point at the same authored statements after the banner is prepended.
  const insertedLineCount = banner.split("\n").length;
  const sourceMap = {
    ...decoded.sourceMap,
    mappings: `${";".repeat(insertedLineCount)}${String(decoded.sourceMap.mappings ?? "")}`,
  };
  const encoded = Buffer.from(JSON.stringify(sourceMap), "utf8").toString("base64");

  return (
    `${banner}\n` +
    input.code.slice(0, decoded.matchStart) +
    decoded.prefix +
    encoded +
    decoded.trailingWhitespace
  );
}

export function rewriteDevSnapshotSourceMap(input: {
  readonly code: string;
  readonly modulePath: string;
  readonly packageRoot?: string;
}): string {
  // Authored modules are imported from content-addressed cache files, and in
  // dev they may originate from immutable runtime snapshots. Rewriting sources
  // to live file URLs keeps DevTools breakpoints attached to editable files
  // instead of cache or snapshot copies.
  const metadata = readDevelopmentRuntimeSnapshotMetadataForPath(input.modulePath);
  const snapshotMetadata =
    metadata !== undefined && isPathInsideOrEqual(input.modulePath, metadata.snapshotSourceRoot)
      ? metadata
      : undefined;

  if (snapshotMetadata === undefined && input.packageRoot === undefined) {
    return input.code;
  }

  const decoded = decodeInlineSourceMap(input.code);
  if (decoded === undefined) {
    return input.code;
  }

  const sources = decoded.sourceMap.sources;
  if (!Array.isArray(sources)) {
    return input.code;
  }

  let changed = false;
  const rewrittenSources = sources.map((source) => {
    if (typeof source !== "string") {
      return source;
    }

    const rewritten =
      snapshotMetadata !== undefined
        ? rewriteDevSnapshotSource({
            metadata: snapshotMetadata,
            modulePath: input.modulePath,
            source,
          })
        : rewriteLiveAuthoredSource({
            modulePath: input.modulePath,
            packageRoot: input.packageRoot!,
            source,
          });
    if (rewritten !== source) {
      changed = true;
    }
    return rewritten;
  });

  if (!changed) {
    return input.code;
  }

  const nextSourceMap = {
    ...decoded.sourceMap,
    sources: rewrittenSources,
  };
  const encoded = Buffer.from(JSON.stringify(nextSourceMap), "utf8").toString("base64");

  return (
    input.code.slice(0, decoded.matchStart) + decoded.prefix + encoded + decoded.trailingWhitespace
  );
}

export function externalizeInlineSourceMap(input: {
  readonly code: string;
  readonly sourceMapFileName: string;
}): { readonly code: string; readonly sourceMap?: Record<string, unknown> } {
  const decoded = decodeInlineSourceMap(input.code);
  if (decoded === undefined) {
    return { code: input.code };
  }

  // These cache modules are imported through `file://...mjs?v=<hash>`. Chrome
  // associates source maps with those URLs more reliably when the map is a
  // sibling file instead of an inline data URL.
  return {
    code:
      input.code.slice(0, decoded.matchStart) +
      `//# sourceMappingURL=${input.sourceMapFileName}` +
      decoded.trailingWhitespace,
    sourceMap: decoded.sourceMap,
  };
}

function decodeInlineSourceMap(code: string):
  | {
      readonly matchStart: number;
      readonly prefix: string;
      readonly sourceMap: Record<string, unknown>;
      readonly trailingWhitespace: string;
    }
  | undefined {
  const match = INLINE_SOURCE_MAP_PATTERN.exec(code);
  if (match === null || match.index === undefined) {
    return undefined;
  }

  try {
    const sourceMap = JSON.parse(Buffer.from(match[2]!, "base64").toString("utf8")) as unknown;
    if (sourceMap === null || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
      return undefined;
    }

    return {
      matchStart: match.index,
      prefix: match[1]!,
      sourceMap: sourceMap as Record<string, unknown>,
      trailingWhitespace: match[3]!,
    };
  } catch {
    return undefined;
  }
}

function rewriteDevSnapshotSource(input: {
  readonly metadata: DevelopmentRuntimeArtifactsSnapshotMetadata;
  readonly modulePath: string;
  readonly source: string;
}): string {
  const sourcePath = normalizeSourceMapPath(input.source);
  if (sourcePath === undefined) {
    return input.source;
  }

  const candidates = createDevSnapshotSourceCandidates({
    metadata: input.metadata,
    modulePath: input.modulePath,
    sourcePath,
  });

  const snapshotCandidates = candidates.filter((candidate) =>
    isPathInsideOrEqual(candidate, input.metadata.snapshotSourceRoot),
  );
  const candidate =
    snapshotCandidates.find((snapshotCandidate) => existsSync(snapshotCandidate)) ??
    snapshotCandidates[0];

  if (candidate !== undefined) {
    return pathToFileURL(
      join(input.metadata.sourceRoot, relative(input.metadata.snapshotSourceRoot, candidate)),
    ).href;
  }

  return input.source;
}

function rewriteLiveAuthoredSource(input: {
  readonly modulePath: string;
  readonly packageRoot: string;
  readonly source: string;
}): string {
  const sourcePath = normalizeSourceMapPath(input.source);
  if (sourcePath === undefined) {
    return input.source;
  }

  const candidates = createLiveAuthoredSourceCandidates({
    modulePath: input.modulePath,
    packageRoot: input.packageRoot,
    sourcePath,
  });
  const candidate =
    candidates.find((sourceCandidate) => existsSync(sourceCandidate)) ?? candidates[0];

  return candidate === undefined ? input.source : pathToFileURL(candidate).href;
}

function createLiveAuthoredSourceCandidates(input: {
  readonly modulePath: string;
  readonly packageRoot: string;
  readonly sourcePath: string;
}): readonly string[] {
  if (isAbsolute(input.sourcePath)) {
    return [input.sourcePath];
  }

  const packageRelativeSource = resolve(
    input.packageRoot,
    stripLeadingRelativeSourceSegments(input.sourcePath),
  );
  const moduleRelativeSource = resolve(dirname(input.modulePath), input.sourcePath);
  const packageRelativeOriginalSource = resolve(input.packageRoot, input.sourcePath);

  return [packageRelativeSource, moduleRelativeSource, packageRelativeOriginalSource];
}

function createDevSnapshotSourceCandidates(input: {
  readonly metadata: DevelopmentRuntimeArtifactsSnapshotMetadata;
  readonly modulePath: string;
  readonly sourcePath: string;
}): readonly string[] {
  if (isAbsolute(input.sourcePath)) {
    return [input.sourcePath];
  }

  const appSourcePath = stripLeadingRelativeSourceSegments(input.sourcePath);
  const moduleRelativeSource = resolve(dirname(input.modulePath), input.sourcePath);
  const appRelativeSource = resolve(input.metadata.runtimeAppRoot, appSourcePath);
  const sourceRootRelativeSource = resolve(input.metadata.snapshotSourceRoot, appSourcePath);
  const appRelativeOriginalSource = resolve(input.metadata.runtimeAppRoot, input.sourcePath);
  const sourceRootRelativeOriginalSource = resolve(
    input.metadata.snapshotSourceRoot,
    input.sourcePath,
  );

  if (input.sourcePath.startsWith("./") || input.sourcePath.startsWith("../")) {
    return [
      moduleRelativeSource,
      appRelativeSource,
      sourceRootRelativeSource,
      appRelativeOriginalSource,
      sourceRootRelativeOriginalSource,
    ];
  }

  return [
    appRelativeSource,
    sourceRootRelativeSource,
    moduleRelativeSource,
    appRelativeOriginalSource,
    sourceRootRelativeOriginalSource,
  ];
}

function stripLeadingRelativeSourceSegments(sourcePath: string): string {
  let stripped = sourcePath;

  while (stripped.startsWith("./") || stripped.startsWith("../")) {
    stripped = stripped.startsWith("./") ? stripped.slice(2) : stripped.slice(3);
  }

  return stripped;
}

function normalizeSourceMapPath(source: string): string | undefined {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      return undefined;
    }
  }

  if (isSourceMapUrl(source)) {
    return undefined;
  }

  return source;
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}
