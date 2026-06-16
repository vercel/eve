import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverNamedSourceDirectory } from "#discover/grammar.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";

/**
 * Diagnostic emitted when the authored `lib/` root exists but is not a
 * directory.
 */
export const DISCOVER_LIB_DIRECTORY_INVALID = "discover/lib-directory-invalid";

/**
 * Diagnostic emitted when discovery finds an unsupported entry under the
 * authored `lib/` tree.
 */
export const DISCOVER_LIB_ENTRY_UNSUPPORTED = "discover/lib-entry-unsupported";

/**
 * Input for discovering authored helper modules under `lib/`.
 */
interface DiscoverLibSourcesInput {
  agentRoot: string;
  rootEntries: readonly ProjectSourceEntry[];
  source: ProjectSource;
}

/**
 * Result of recursively discovering authored helper modules under `lib/`.
 */
interface DiscoverLibSourcesResult {
  diagnostics: DiscoverDiagnostic[];
  lib: ModuleSourceRef[];
}

/**
 * Discovers module-only helper sources under `lib/` without executing
 * authored modules.
 */
export async function discoverLibSources(
  input: DiscoverLibSourcesInput,
): Promise<DiscoverLibSourcesResult> {
  const result = await discoverNamedSourceDirectory({
    directoryName: "lib",
    invalidDirectoryCode: DISCOVER_LIB_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${input.agentRoot}/lib" to be a directory of authored helper modules.`,
    recursive: true,
    rootEntries: input.rootEntries,
    rootPath: input.agentRoot,
    source: input.source,
    unsupportedEntryCode: DISCOVER_LIB_ENTRY_UNSUPPORTED,
    unsupportedEntryMessage: (sourcePath) =>
      `Expected "${sourcePath}" to be a supported authored module within "lib/".`,
    unsupportedFileCode: DISCOVER_LIB_ENTRY_UNSUPPORTED,
    unsupportedFileMessage: (sourcePath) =>
      `Expected "${sourcePath}" to be a supported authored module within "lib/".`,
  });

  return {
    diagnostics: result.diagnostics,
    lib: result.sources,
  };
}
