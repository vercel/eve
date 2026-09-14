import { join } from "node:path";

import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { matchesSupportedModuleBaseName, stripLogicalPathExtension } from "#discover/filesystem.js";
import { TOOL_SLUG_PATTERN, discoverFlatModuleSource } from "#discover/grammar.js";
import type { MemorySourceRef } from "#discover/manifest.js";
import { discoverNamedSourceDirectory } from "#discover/named-source-directory.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";

export const DISCOVER_MEMORY_DIRECTORY_INVALID = "discover/memory-directory-invalid";
export const DISCOVER_MEMORY_SLOT_AMBIGUOUS = "discover/memory-slot-ambiguous";
export const DISCOVER_MEMORY_NAME_INVALID = "discover/memory-name-invalid";

export async function discoverMemorySources(input: {
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly rootPath: string;
  readonly source: ProjectSource;
}): Promise<{ readonly diagnostics: DiscoverDiagnostic[]; readonly memories: MemorySourceRef[] }> {
  const flat = discoverFlatModuleSource({
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    slotName: "memory",
  });
  const hasFlatModule = input.rootEntries.some(
    (entry) => entry.isFile() && matchesSupportedModuleBaseName(entry.name, "memory"),
  );
  const hasDirectory = input.rootEntries.some(
    (entry) => entry.name === "memory" && entry.isDirectory(),
  );
  const directory = await discoverNamedSourceDirectory({
    directoryName: "memory",
    invalidDirectoryCode: DISCOVER_MEMORY_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.rootPath, "memory")}" to be a directory of authored memory slots.`,
    recursive: false,
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    source: input.source,
    validateSegment: createMemoryNameDiagnostic,
  });

  if (hasFlatModule && hasDirectory) {
    return {
      diagnostics: [
        ...flat.diagnostics,
        ...directory.diagnostics,
        createDiscoverErrorDiagnostic({
          code: DISCOVER_MEMORY_SLOT_AMBIGUOUS,
          message:
            'Memory must use either the flat "memory.ts" form or the named "memory/" directory form, not both.',
          sourcePath: input.rootPath,
        }),
      ],
      memories: [],
    };
  }
  if (flat.module !== undefined) {
    return {
      diagnostics: [...flat.diagnostics, ...directory.diagnostics],
      memories: [{ ...flat.module, slot: "memory" }],
    };
  }
  return {
    diagnostics: [...flat.diagnostics, ...directory.diagnostics],
    memories: directory.sources.map((source) => ({
      ...source,
      slot: stripLogicalPathExtension(source.logicalPath).slice("memory/".length),
    })),
  };
}

function createMemoryNameDiagnostic(
  segment: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (TOOL_SLUG_PATTERN.test(segment)) return null;
  return createDiscoverErrorDiagnostic({
    code: DISCOVER_MEMORY_NAME_INVALID,
    message: `Memory slot "${segment}" must start with an ASCII letter and contain only letters, digits, underscores, or dashes (64 characters maximum).`,
    sourcePath,
  });
}
