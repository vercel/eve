import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverNamedSourceDirectory } from "#discover/grammar.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";

export const DISCOVER_LIB_DIRECTORY_INVALID = "discover/lib-directory-invalid";

export const DISCOVER_LIB_ENTRY_UNSUPPORTED = "discover/lib-entry-unsupported";

interface DiscoverLibSourcesInput {
  agentRoot: string;
  rootEntries: readonly ProjectSourceEntry[];
  source: ProjectSource;
}

interface DiscoverLibSourcesResult {
  diagnostics: DiscoverDiagnostic[];
  lib: ModuleSourceRef[];
}

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
      `Expected "${sourcePath}" to be a regular file or directory within "lib/".`,
  });

  return {
    diagnostics: result.diagnostics,
    lib: result.sources,
  };
}
