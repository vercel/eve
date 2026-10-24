import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import type { CompactionSourceRef } from "#discover/manifest.js";
import { discoverFlatModuleSource } from "#discover/grammar.js";
import type { ProjectSourceEntry } from "#discover/project-source.js";

export function discoverCompactionSource(input: {
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly rootPath: string;
}): {
  readonly compaction: CompactionSourceRef | null;
  readonly diagnostics: DiscoverDiagnostic[];
} {
  const flat = discoverFlatModuleSource({
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    slotName: "compaction",
  });
  return { compaction: flat.module ?? null, diagnostics: flat.diagnostics };
}
