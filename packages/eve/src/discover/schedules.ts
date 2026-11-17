import { join } from "node:path";

import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import { lowerScheduleMarkdown } from "#internal/helpers/markdown.js";
import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverNamedSourceDirectory } from "#discover/grammar.js";
import type { ScheduleSourceRef } from "#discover/manifest.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";

export const DISCOVER_SCHEDULES_DIRECTORY_INVALID = "discover/schedules-directory-invalid";

export const DISCOVER_SCHEDULE_FILE_UNSUPPORTED = "discover/schedule-file-unsupported";

interface DiscoverScheduleSourcesInput {
  agentRoot: string;
  rootEntries: readonly ProjectSourceEntry[];
  source: ProjectSource;
}

interface DiscoverScheduleSourcesResult {
  diagnostics: DiscoverDiagnostic[];
  schedules: ScheduleSourceRef[];
}

export async function discoverScheduleSources(
  input: DiscoverScheduleSourcesInput,
): Promise<DiscoverScheduleSourcesResult> {
  const schedulesRoot = join(input.agentRoot, "schedules");

  const result = await discoverNamedSourceDirectory<ScheduleDefinition>({
    allowMarkdown: true,
    directoryName: "schedules",
    invalidDirectoryCode: DISCOVER_SCHEDULES_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${schedulesRoot}" to be a directory of authored schedules.`,
    markdownLowerer: (markdown) => lowerScheduleMarkdown(markdown),
    recursive: true,
    rootEntries: input.rootEntries,
    rootPath: input.agentRoot,
    source: input.source,
    unsupportedFileCode: DISCOVER_SCHEDULE_FILE_UNSUPPORTED,
    unsupportedFileMessage: (sourcePath) =>
      `Expected "${sourcePath}" to be a TypeScript or markdown schedule file within "schedules/".`,
  });

  return {
    diagnostics: result.diagnostics,
    schedules: result.sources,
  };
}
