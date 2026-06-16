/**
 * Runtime-owned compiled artifact paths for one application root.
 */
export interface RuntimeCompilerArtifactPaths {
  readonly appRoot: string;
  readonly compiledManifestPath: string;
  readonly compileDirectoryPath: string;
  readonly compileMetadataPath: string;
  readonly diagnosticsPath: string;
  readonly discoveryManifestPath: string;
  readonly discoveryDirectoryPath: string;
  readonly moduleMapPath: string;
}

/**
 * Resolves the stable eve artifact paths for one application root without
 * depending on Node path helpers.
 */
export function resolveRuntimeCompilerArtifactPaths(appRoot: string): RuntimeCompilerArtifactPaths {
  const normalizedAppRoot = normalizeFilesystemPath(appRoot);
  const discoveryDirectoryPath = `${normalizedAppRoot}/.eve/discovery`;
  const compileDirectoryPath = `${normalizedAppRoot}/.eve/compile`;

  return {
    appRoot: normalizedAppRoot,
    compiledManifestPath: `${compileDirectoryPath}/compiled-agent-manifest.json`,
    compileDirectoryPath,
    compileMetadataPath: `${compileDirectoryPath}/compile-metadata.json`,
    diagnosticsPath: `${discoveryDirectoryPath}/diagnostics.json`,
    discoveryDirectoryPath,
    discoveryManifestPath: `${discoveryDirectoryPath}/agent-discovery-manifest.json`,
    moduleMapPath: `${compileDirectoryPath}/module-map.mjs`,
  };
}

function normalizeFilesystemPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");

  if (normalized === "/") {
    return normalized;
  }

  return normalized.replace(/\/+$/, "");
}
