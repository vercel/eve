import { join } from "node:path";

import type { MarkdownSourceRef, ModuleSourceRef } from "#shared/source-ref.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  getDirectoryEntryType,
  getSupportedModuleBaseName,
  isTypeScriptDeclarationFileName,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import {
  createModuleSlotCollisionDiagnostic,
  createSlotCollisionDiagnostic,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { createModuleSourceRef } from "#discover/manifest.js";
import { discoverMarkdownSource } from "#discover/markdown.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import { collectNamedSlotCandidates } from "#discover/slots.js";

interface DiscoverNamedSourceDirectoryBaseInput {
  directoryName: string;
  invalidDirectoryCode: string;
  invalidDirectoryMessage: string;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
  recursive: boolean;
  validateSegment?: (segment: string, sourcePath: string) => DiscoverDiagnostic | null;
  unsupportedFileCode?: string;
  unsupportedFileMessage?: (sourcePath: string, directoryName: string) => string;
  unsupportedEntryCode?: string;
  unsupportedEntryMessage?: (sourcePath: string, directoryName: string) => string;
}

export interface DiscoverNamedSourceDirectoryModuleInput extends DiscoverNamedSourceDirectoryBaseInput {
  allowMarkdown?: false;
}

export interface DiscoverNamedSourceDirectoryWithMarkdownInput<
  TDefinition,
> extends DiscoverNamedSourceDirectoryBaseInput {
  allowMarkdown: true;
  markdownLowerer: (markdown: string, input: { name: string }) => TDefinition;
}

export async function discoverNamedSourceDirectory(
  input: DiscoverNamedSourceDirectoryModuleInput,
): Promise<{
  diagnostics: DiscoverDiagnostic[];
  sources: ModuleSourceRef[];
}>;
export async function discoverNamedSourceDirectory<TDefinition>(
  input: DiscoverNamedSourceDirectoryWithMarkdownInput<TDefinition>,
): Promise<{
  diagnostics: DiscoverDiagnostic[];
  sources: (MarkdownSourceRef<TDefinition> | ModuleSourceRef)[];
}>;
export async function discoverNamedSourceDirectory<TDefinition>(
  input:
    | DiscoverNamedSourceDirectoryModuleInput
    | DiscoverNamedSourceDirectoryWithMarkdownInput<TDefinition>,
): Promise<{
  diagnostics: DiscoverDiagnostic[];
  sources: (MarkdownSourceRef<TDefinition> | ModuleSourceRef)[];
}> {
  const directoryPath = join(input.rootPath, input.directoryName);
  const directoryEntry = input.rootEntries.find((entry) => entry.name === input.directoryName);

  if (directoryEntry === undefined) {
    return { diagnostics: [], sources: [] };
  }

  if (!directoryEntry.isDirectory()) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: input.invalidDirectoryCode,
          message: input.invalidDirectoryMessage,
          sourcePath: directoryPath,
        }),
      ],
      sources: [],
    };
  }

  const diagnostics: DiscoverDiagnostic[] = [];
  const sources: (MarkdownSourceRef<TDefinition> | ModuleSourceRef)[] = [];

  await walkNamedSourceDirectory<TDefinition>({
    allowMarkdown: input.allowMarkdown === true,
    diagnostics,
    markdownLowerer:
      input.allowMarkdown === true
        ? (input as DiscoverNamedSourceDirectoryWithMarkdownInput<TDefinition>).markdownLowerer
        : undefined,
    projectSource: input.source,
    recursive: input.recursive,
    relativeDirectory: input.directoryName,
    rootDirectoryPath: directoryPath,
    sources,
    subdirectoryRelative: "",
    unsupportedEntryCode: input.unsupportedEntryCode,
    unsupportedEntryMessage: input.unsupportedEntryMessage,
    unsupportedFileCode: input.unsupportedFileCode,
    unsupportedFileMessage: input.unsupportedFileMessage,
    validateSegment: input.validateSegment,
  });

  return { diagnostics, sources };
}

interface WalkNamedSourceDirectoryInput<TDefinition> {
  allowMarkdown: boolean;
  diagnostics: DiscoverDiagnostic[];
  markdownLowerer?: (markdown: string, input: { name: string }) => TDefinition;
  projectSource: ProjectSource;
  recursive: boolean;
  relativeDirectory: string;
  rootDirectoryPath: string;
  sources: (MarkdownSourceRef<TDefinition> | ModuleSourceRef)[];
  subdirectoryRelative: string;
  unsupportedEntryCode?: string;
  unsupportedEntryMessage?: (sourcePath: string, directoryName: string) => string;
  unsupportedFileCode?: string;
  unsupportedFileMessage?: (sourcePath: string, directoryName: string) => string;
  validateSegment?: (segment: string, sourcePath: string) => DiscoverDiagnostic | null;
}

async function walkNamedSourceDirectory<TDefinition>(
  input: WalkNamedSourceDirectoryInput<TDefinition>,
): Promise<void> {
  const absoluteDirectory =
    input.subdirectoryRelative === ""
      ? input.rootDirectoryPath
      : join(input.rootDirectoryPath, input.subdirectoryRelative);
  const directoryEntries = await readSortedDirectoryEntries(input.projectSource, absoluteDirectory);

  if (input.recursive) {
    await walkSubdirectories(input, directoryEntries, absoluteDirectory);
  }

  if (input.unsupportedFileCode !== undefined || input.unsupportedEntryCode !== undefined) {
    emitUnsupportedLeafDiagnostics(input, directoryEntries, absoluteDirectory);
  }

  await collectLeafSources(input, directoryEntries, absoluteDirectory);
}

async function walkSubdirectories<TDefinition>(
  input: WalkNamedSourceDirectoryInput<TDefinition>,
  directoryEntries: readonly ProjectSourceEntry[],
  absoluteDirectory: string,
): Promise<void> {
  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const segmentPath = join(absoluteDirectory, entry.name);

    if (input.validateSegment !== undefined) {
      const segmentDiagnostic = input.validateSegment(entry.name, segmentPath);
      if (segmentDiagnostic !== null) {
        input.diagnostics.push(segmentDiagnostic);
        continue;
      }
    }

    await walkNamedSourceDirectory<TDefinition>({
      allowMarkdown: input.allowMarkdown,
      diagnostics: input.diagnostics,
      markdownLowerer: input.markdownLowerer,
      projectSource: input.projectSource,
      recursive: input.recursive,
      relativeDirectory: input.relativeDirectory,
      rootDirectoryPath: input.rootDirectoryPath,
      sources: input.sources,
      subdirectoryRelative:
        input.subdirectoryRelative === ""
          ? entry.name
          : join(input.subdirectoryRelative, entry.name),
      unsupportedEntryCode: input.unsupportedEntryCode,
      unsupportedEntryMessage: input.unsupportedEntryMessage,
      unsupportedFileCode: input.unsupportedFileCode,
      unsupportedFileMessage: input.unsupportedFileMessage,
      validateSegment: input.validateSegment,
    });
  }
}

function emitUnsupportedLeafDiagnostics<TDefinition>(
  input: WalkNamedSourceDirectoryInput<TDefinition>,
  directoryEntries: readonly ProjectSourceEntry[],
  absoluteDirectory: string,
): void {
  for (const entry of directoryEntries) {
    const entryType = getDirectoryEntryType(entry);
    const entryPath = join(absoluteDirectory, entry.name);

    if (entryType === "directory") {
      continue;
    }

    if (entryType === "other") {
      if (input.unsupportedEntryCode !== undefined) {
        input.diagnostics.push(
          createDiscoverErrorDiagnostic({
            code: input.unsupportedEntryCode,
            message:
              input.unsupportedEntryMessage?.(entryPath, input.relativeDirectory) ??
              `Expected "${entryPath}" to be a regular file or directory within "${input.relativeDirectory}/".`,
            sourcePath: entryPath,
          }),
        );
      }
      continue;
    }

    if (input.unsupportedFileCode === undefined) {
      continue;
    }

    if (isTypeScriptDeclarationFileName(entry.name)) {
      continue;
    }

    const isModule = getSupportedModuleBaseName(entry.name) !== null;
    const isMarkdown = input.allowMarkdown && entry.name.endsWith(".md");

    if (isModule || isMarkdown) {
      continue;
    }

    input.diagnostics.push(
      createDiscoverErrorDiagnostic({
        code: input.unsupportedFileCode,
        message:
          input.unsupportedFileMessage?.(entryPath, input.relativeDirectory) ??
          `Expected "${entryPath}" to be a supported authored source within "${input.relativeDirectory}/".`,
        sourcePath: entryPath,
      }),
    );
  }
}

async function collectLeafSources<TDefinition>(
  input: WalkNamedSourceDirectoryInput<TDefinition>,
  directoryEntries: readonly ProjectSourceEntry[],
  absoluteDirectory: string,
): Promise<void> {
  for (const candidates of collectNamedSlotCandidates(directoryEntries, {
    allowMarkdown: input.allowMarkdown,
    allowModules: true,
  })) {
    const slotSubpath =
      input.subdirectoryRelative === ""
        ? candidates.slotName
        : join(input.subdirectoryRelative, candidates.slotName);
    const slotLogicalPath = normalizeLogicalPath(join(input.relativeDirectory, slotSubpath));

    if (input.validateSegment !== undefined) {
      const probeFileName =
        candidates.markdownFileName ?? candidates.moduleFileNames[0] ?? candidates.slotName;
      const segmentDiagnostic = input.validateSegment(
        candidates.slotName,
        join(absoluteDirectory, probeFileName),
      );
      if (segmentDiagnostic !== null) {
        input.diagnostics.push(segmentDiagnostic);
        continue;
      }
    }

    if (candidates.markdownFileName !== undefined && candidates.moduleFileNames.length > 0) {
      input.diagnostics.push(
        createSlotCollisionDiagnostic(absoluteDirectory, slotLogicalPath, [
          candidates.markdownFileName,
          ...candidates.moduleFileNames,
        ]),
      );
      continue;
    }

    if (candidates.moduleFileNames.length > 1) {
      input.diagnostics.push(
        createModuleSlotCollisionDiagnostic(
          absoluteDirectory,
          slotLogicalPath,
          candidates.moduleFileNames,
        ),
      );
      continue;
    }

    if (candidates.markdownFileName !== undefined) {
      const fileSubpath =
        input.subdirectoryRelative === ""
          ? candidates.markdownFileName
          : join(input.subdirectoryRelative, candidates.markdownFileName);
      const markdownLogicalPath = normalizeLogicalPath(join(input.relativeDirectory, fileSubpath));

      if (input.markdownLowerer === undefined) {
        continue;
      }

      const markdownRef = await discoverMarkdownSource({
        logicalPath: markdownLogicalPath,
        lower: input.markdownLowerer,
        source: input.projectSource,
        sourcePath: join(input.rootDirectoryPath, fileSubpath),
      });
      input.sources.push(markdownRef);
      continue;
    }

    const [logicalFileName] = candidates.moduleFileNames;

    if (logicalFileName === undefined) {
      continue;
    }

    const fileSubpath =
      input.subdirectoryRelative === ""
        ? logicalFileName
        : join(input.subdirectoryRelative, logicalFileName);
    input.sources.push(
      createModuleSourceRef({
        logicalPath: normalizeLogicalPath(join(input.relativeDirectory, fileSubpath)),
      }),
    );
  }
}
