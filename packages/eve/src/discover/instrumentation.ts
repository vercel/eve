import { join } from "node:path";

import { discoverFlatModuleSource } from "#discover/grammar.js";
import { discoverNamedSourceDirectory } from "#discover/named-source-directory.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export const DISCOVER_INSTRUMENTATION_DIRECTORY_INVALID =
  "discover/instrumentation-directory-invalid";

/** Discovers both legal instrumentation layouts without selecting one. */
export async function discoverInstrumentationSources(input: {
  readonly nodeId: string;
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly rootPath: string;
  readonly source: ProjectSource;
}): Promise<{
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly file?: ModuleSourceRef;
  readonly providers: readonly ModuleSourceRef[];
}> {
  const { nodeId } = input;
  const file = discoverFlatModuleSource({
    nodeId,
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    slotName: "instrumentation",
  });
  const providers = await discoverNamedSourceDirectory({
    directoryName: "instrumentation",
    invalidDirectoryCode: DISCOVER_INSTRUMENTATION_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.rootPath, "instrumentation")}" to be a directory of authored instrumentation providers.`,
    nodeId,
    recursive: false,
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    source: input.source,
  });

  const result: {
    diagnostics: readonly CompilerDiagnostic[];
    file?: ModuleSourceRef;
    providers: readonly ModuleSourceRef[];
  } = {
    diagnostics: [...file.diagnostics, ...providers.diagnostics],
    providers: providers.sources,
  };
  if (file.module !== undefined) result.file = file.module;
  return result;
}
