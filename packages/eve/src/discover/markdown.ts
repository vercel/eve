import type { MarkdownSourceRef } from "#shared/source-ref.js";
import { normalizeLogicalPath, stripLogicalPathExtension } from "#discover/filesystem.js";
import { createPathDerivedSourceId } from "#discover/manifest.js";
import type { ProjectSource } from "#discover/project-source.js";

interface DiscoverMarkdownSourceInput<TDefinition> {
  logicalPath: string;
  lower: (source: string, input: { name: string }) => TDefinition;
  source: ProjectSource;
  sourcePath: string;
}

export async function discoverMarkdownSource<TDefinition>(
  input: DiscoverMarkdownSourceInput<TDefinition>,
): Promise<MarkdownSourceRef<TDefinition>> {
  const logicalPath = normalizeLogicalPath(input.logicalPath);

  return {
    definition: input.lower(await input.source.readTextFile(input.sourcePath), {
      name: stripLogicalPathExtension(logicalPath),
    }),
    sourceKind: "markdown",
    logicalPath,
    sourceId: createPathDerivedSourceId(logicalPath),
  };
}
