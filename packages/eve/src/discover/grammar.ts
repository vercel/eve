import type { Dirent } from "node:fs";
import { join } from "node:path";

import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import { lowerInstructionsMarkdown } from "#internal/helpers/markdown.js";
import {
  createDiscoverErrorDiagnostic,
  createDiscoverWarningDiagnostic,
  type DiscoverDiagnostic,
} from "#discover/diagnostics.js";
import { type DirectoryEntryType, getDirectoryEntryType } from "#discover/filesystem.js";
import { type InstructionsSourceRef, createModuleSourceRef } from "#discover/manifest.js";
import { discoverMarkdownSource } from "#discover/markdown.js";
import { discoverNamedSourceDirectory } from "#discover/named-source-directory.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import { collectFlatSlotCandidates } from "#discover/slots.js";

/**
 * Shared diagnostic emitted when a slot has multiple authored module sources.
 */
export const DISCOVER_MODULE_SLOT_COLLISION = "discover/module-slot-collision";

/**
 * Shared diagnostic emitted when the required instructions prompt source
 * is missing.
 */
export const DISCOVER_REQUIRED_INSTRUCTIONS_MISSING = "discover/required-instructions-missing";

/**
 * Shared diagnostic emitted when discovery falls back to the deprecated
 * `system.{md,ts,...}` slot because no `instructions.{md,ts,...}` source
 * was found. The fallback resolves successfully; the warning prompts the
 * author to rename the file.
 */
export const DISCOVER_DEPRECATED_SYSTEM_SLOT = "discover/deprecated-system-slot";

/**
 * Shared diagnostic emitted when a slot has both markdown and module sources.
 */
export const DISCOVER_SLOT_COLLISION = "discover/slot-collision";

/**
 * Shared diagnostic emitted when the authored `tools/` root is not a
 * directory.
 */
export const DISCOVER_TOOLS_DIRECTORY_INVALID = "discover/tools-directory-invalid";

/**
 * Shared diagnostic emitted when the authored `hooks/` root is not a
 * directory.
 */
export const DISCOVER_HOOKS_DIRECTORY_INVALID = "discover/hooks-directory-invalid";

/**
 * Shared diagnostic emitted when the authored `channels/` root is not a
 * directory.
 */
export const DISCOVER_CHANNELS_DIRECTORY_INVALID = "discover/channels-directory-invalid";

/**
 * Shared diagnostic emitted when an authored `tools/*.{ts,…}` filename does
 * not satisfy the model tool-name charset rule.
 */
export const DISCOVER_TOOL_NAME_INVALID = "discover/tool-name-invalid";

/**
 * Shared diagnostic emitted when an authored `connections/*.{ts,…}` filename
 * does not satisfy the connection slug charset rule.
 */
export const DISCOVER_CONNECTION_NAME_INVALID = "discover/connection-name-invalid";

/**
 * Shared diagnostic emitted when the authored `sandbox/` root is not a
 * directory. The diagnostic code string retains its plural suffix for
 * stability across manifest versions.
 */
export const DISCOVER_SANDBOX_DIRECTORY_INVALID = "discover/sandbox-directory-invalid";

/**
 * Shared diagnostic emitted when the authored `instructions/` root is not a
 * directory.
 */
export const DISCOVER_INSTRUCTIONS_DIRECTORY_INVALID = "discover/instructions-directory-invalid";

/**
 * Shared diagnostic emitted when an authored `channels/**` filename or
 * directory segment does not satisfy the channel slug charset rule.
 */
export const DISCOVER_CHANNEL_NAME_INVALID = "discover/channel-name-invalid";

/**
 * Shared diagnostic emitted when an authored `hooks/**` filename or
 * directory segment does not satisfy the hook slug charset rule.
 */
export const DISCOVER_HOOK_NAME_INVALID = "discover/hook-name-invalid";

/**
 * Tool filename charset. The slug must start with an ASCII letter and may
 * contain ASCII letters, digits, underscores, and dashes. The 64-character
 * cap matches the most restrictive provider tool-name limit.
 *
 * The model-facing tool name is the filename slug verbatim — there is no
 * authored `name` override and no compile-time normalization. Authors who
 * want a snake_case identifier should name the file in snake_case.
 */
export const TOOL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Connection filename charset. Connections use the same lowercase
 * kebab-case rule as sandbox since they are not directly exposed to
 * model APIs as identifiers.
 */
export const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Channel filename / directory segment charset.
 */
export const CHANNEL_SLUG_PATTERN = /^(\.?[a-z][a-z0-9-]{0,63}|\[[a-zA-Z][a-zA-Z0-9_]{0,63}\])$/;

/**
 * Hook filename / directory segment charset. Each segment of the
 * path-relative slug uses the same restrictive charset as tool slugs:
 * ASCII letters, digits, underscores, and dashes, starting with a
 * letter, up to 64 characters per segment. Bracketed parameter forms
 * are not allowed — hooks have no URL semantics.
 */
export const HOOK_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Shared diagnostic emitted when discovery ignores one unsupported directory.
 */
export const DISCOVER_UNSUPPORTED_DIRECTORY = "discover/unsupported-directory";

/**
 * Structural `Dirent`-like entry used throughout discovery.
 *
 * Legacy alias preserved for backwards compatibility inside `src/discover/`.
 * Every discover function now consumes {@link ProjectSourceEntry}, which
 * has the same three properties (`name`, `isDirectory()`, `isFile()`). Real
 * `Dirent<string>` values from `node:fs` satisfy this shape, so
 * {@link createDiskProjectSource} returns them directly.
 */
export type StringDirent = Dirent<string>;

/**
 * Reads one directory through `source` and returns its entries sorted by name.
 */
export async function readSortedDirectoryEntries(
  source: ProjectSource,
  directoryPath: string,
): Promise<ProjectSourceEntry[]> {
  const entries = [...(await source.readDirectory(directoryPath))];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  return entries;
}

/**
 * Discovers instructions sources from a root directory.
 *
 * Supports three forms:
 * 1. **Directory**: `agent/instructions/` with multiple `.md` and `.ts` files.
 * 2. **Flat file**: `agent/instructions.md` or `agent/instructions.{ts,...}`.
 * 3. **Legacy**: `agent/system.{md,ts,...}` with a deprecation warning.
 *
 * A flat file and a directory can coexist — the flat file appears first
 * in the returned array.
 */
export async function discoverInstructionsSource(input: {
  required?: boolean;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
}): Promise<{
  diagnostics: DiscoverDiagnostic[];
  instructions: InstructionsSourceRef[];
}> {
  const hasDirectory = input.rootEntries.some((e) => e.name === "instructions" && e.isDirectory());

  // Check for flat-file candidates alongside the directory.
  const flatResult = await discoverSlotSource({
    markdownFileName: "instructions.md",
    moduleBaseName: "instructions",
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    slotLabel: "instructions",
    source: input.source,
  });

  if (hasDirectory) {
    const dirResult = await discoverNamedSourceDirectory<InstructionsDefinition>({
      allowMarkdown: true,
      directoryName: "instructions",
      invalidDirectoryCode: DISCOVER_INSTRUCTIONS_DIRECTORY_INVALID,
      invalidDirectoryMessage: `Expected "${join(input.rootPath, "instructions")}" to be a directory of authored instructions.`,
      markdownLowerer: (markdown) => lowerInstructionsMarkdown(markdown),
      recursive: false,
      rootEntries: input.rootEntries,
      rootPath: input.rootPath,
      source: input.source,
    });
    const instructions = [...dirResult.sources];
    if (flatResult.source !== undefined) {
      instructions.unshift(flatResult.source);
    }
    return {
      diagnostics: [...flatResult.diagnostics, ...dirResult.diagnostics],
      instructions,
    };
  }

  // Flat file path.
  if (flatResult.diagnostics.length > 0 || flatResult.source !== undefined) {
    return {
      diagnostics: flatResult.diagnostics,
      instructions: flatResult.source !== undefined ? [flatResult.source] : [],
    };
  }

  // Legacy system.{md,ts,...} fallback.
  const legacyResult = await discoverSlotSource({
    markdownFileName: "system.md",
    moduleBaseName: "system",
    rootEntries: input.rootEntries,
    rootPath: input.rootPath,
    slotLabel: "system",
    source: input.source,
  });

  if (legacyResult.source !== undefined) {
    const fileName =
      legacyResult.source.sourceKind === "markdown" ? "system.md" : legacyResult.source.logicalPath;
    return {
      diagnostics: [
        createDiscoverWarningDiagnostic({
          code: DISCOVER_DEPRECATED_SYSTEM_SLOT,
          message: `The "${fileName}" slot is deprecated. Rename it to "${fileName.replace(/^system/, "instructions")}" — the runtime still loads the legacy slot for now, but support will be removed in a future release.`,
          sourcePath: join(input.rootPath, fileName),
        }),
        ...legacyResult.diagnostics,
      ],
      instructions: [legacyResult.source],
    };
  }

  if (legacyResult.diagnostics.length > 0) {
    return {
      diagnostics: legacyResult.diagnostics,
      instructions: [],
    };
  }

  if (input.required === false) {
    return {
      diagnostics: [],
      instructions: [],
    };
  }

  return {
    diagnostics: [
      createDiscoverErrorDiagnostic({
        code: DISCOVER_REQUIRED_INSTRUCTIONS_MISSING,
        message:
          'Expected authored instructions at "instructions.md", "instructions.ts", "instructions.cts", "instructions.mts", "instructions.js", "instructions.cjs", "instructions.mjs", or "instructions/" directory.',
        sourcePath: input.rootPath,
      }),
    ],
    instructions: [],
  };
}

async function discoverSlotSource(input: {
  markdownFileName: string;
  moduleBaseName: string;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  slotLabel: string;
  source: ProjectSource;
}): Promise<{
  diagnostics: DiscoverDiagnostic[];
  source?: InstructionsSourceRef;
}> {
  const candidates = collectFlatSlotCandidates(input.rootEntries, {
    markdownFileName: input.markdownFileName,
    moduleBaseName: input.moduleBaseName,
  });

  if (candidates.markdownFileName !== undefined && candidates.moduleFileNames.length > 0) {
    return {
      diagnostics: [
        createSlotCollisionDiagnostic(input.rootPath, input.slotLabel, [
          candidates.markdownFileName,
          ...candidates.moduleFileNames,
        ]),
      ],
    };
  }

  if (candidates.moduleFileNames.length > 1) {
    return {
      diagnostics: [
        createModuleSlotCollisionDiagnostic(
          input.rootPath,
          input.slotLabel,
          candidates.moduleFileNames,
        ),
      ],
    };
  }

  if (candidates.markdownFileName !== undefined) {
    return {
      diagnostics: [],
      source: await discoverMarkdownSource({
        logicalPath: input.markdownFileName,
        lower: lowerInstructionsMarkdown,
        source: input.source,
        sourcePath: join(input.rootPath, candidates.markdownFileName),
      }),
    };
  }

  const [logicalPath] = candidates.moduleFileNames;

  if (logicalPath !== undefined) {
    return {
      diagnostics: [],
      source: createModuleSourceRef({
        logicalPath,
      }),
    };
  }

  return { diagnostics: [] };
}

/**
 * Discovers one flat module slot such as `agent.ts` or `subagent.cjs`.
 */
export function discoverFlatModuleSource(input: {
  missingDiagnostic?: {
    code: string;
    message: string;
  };
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  slotName: string;
}): {
  diagnostics: DiscoverDiagnostic[];
  module?: ModuleSourceRef;
} {
  const candidates = collectFlatSlotCandidates(input.rootEntries, {
    moduleBaseName: input.slotName,
  });

  if (candidates.moduleFileNames.length > 1) {
    return {
      diagnostics: [
        createModuleSlotCollisionDiagnostic(
          input.rootPath,
          input.slotName,
          candidates.moduleFileNames,
        ),
      ],
    };
  }

  const [logicalPath] = candidates.moduleFileNames;

  if (logicalPath !== undefined) {
    return {
      diagnostics: [],
      module: createModuleSourceRef({
        logicalPath,
      }),
    };
  }

  if (input.missingDiagnostic === undefined) {
    return {
      diagnostics: [],
    };
  }

  return {
    diagnostics: [
      createDiscoverErrorDiagnostic({
        code: input.missingDiagnostic.code,
        message: input.missingDiagnostic.message,
        sourcePath: input.rootPath,
      }),
    ],
  };
}

/**
 * Returns a discovery diagnostic when a tool slot name violates
 * {@link TOOL_SLUG_PATTERN}, or `null` when it satisfies the rule.
 *
 * Wired in by {@link discoverNamedSourceDirectory} callers via
 * `validateSegment` so the discover layer rejects illegal filenames before
 * the compiler ever loads the module.
 */
export function createToolNameDiagnostic(
  slotName: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (TOOL_SLUG_PATTERN.test(slotName)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_TOOL_NAME_INVALID,
    message:
      `Tool filename "${slotName}" is not a legal tool name. ` +
      `Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.`,
    sourcePath,
  });
}

/**
 * Returns a discovery diagnostic when a connection slot name violates
 * {@link CONNECTION_SLUG_PATTERN}, or `null` when it satisfies the rule.
 */
export function createConnectionNameDiagnostic(
  slotName: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (CONNECTION_SLUG_PATTERN.test(slotName)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_CONNECTION_NAME_INVALID,
    message:
      `Connection filename "${slotName}" is not a legal connection name. ` +
      `Expected lowercase ASCII letters, digits, and dashes only, starting with a letter, up to 64 characters.`,
    sourcePath,
  });
}

/**
 * Returns a discovery diagnostic when a channel filesystem segment violates
 * {@link CHANNEL_SLUG_PATTERN}, or `null` when it satisfies the rule.
 *
 * Each path segment under `agent/channels/` is validated independently —
 * file leaves and directory ancestors both go through this check so the
 * runtime never sees a malformed URL segment.
 */
export function createChannelNameDiagnostic(
  segment: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (CHANNEL_SLUG_PATTERN.test(segment)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_CHANNEL_NAME_INVALID,
    message:
      `Channel path segment "${segment}" is not a legal channel name. ` +
      `Expected lowercase kebab-case (\`my-channel\`), optionally with a leading dot (\`.well-known\`), or a path parameter form (\`[sessionId]\`).`,
    sourcePath,
  });
}

/**
 * Returns a discovery diagnostic when a hook filesystem segment violates
 * {@link HOOK_SLUG_PATTERN}, or `null` when it satisfies the rule.
 *
 * Each path segment under `agent/hooks/` is validated independently so
 * the runtime never sees a malformed slug.
 */
export function createHookNameDiagnostic(
  segment: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (HOOK_SLUG_PATTERN.test(segment)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_HOOK_NAME_INVALID,
    message:
      `Hook path segment "${segment}" is not a legal hook name. ` +
      `Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.`,
    sourcePath,
  });
}

export {
  discoverNamedSourceDirectory,
  type DiscoverNamedSourceDirectoryModuleInput,
  type DiscoverNamedSourceDirectoryWithMarkdownInput,
} from "#discover/named-source-directory.js";

/**
 * Emits shared diagnostics for unsupported root-level directories.
 */
export function createUnsupportedRootDirectoryDiagnostics(input: {
  classifyEntry: (name: string, entryType: DirectoryEntryType) => string;
  createUnsupportedDirectoryMessage: (directoryName: string) => string;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
}): DiscoverDiagnostic[] {
  return input.rootEntries.flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }

    if (input.classifyEntry(entry.name, getDirectoryEntryType(entry)) !== "unknown") {
      return [];
    }

    return [
      createDiscoverWarningDiagnostic({
        code: DISCOVER_UNSUPPORTED_DIRECTORY,
        message: input.createUnsupportedDirectoryMessage(entry.name),
        sourcePath: join(input.rootPath, entry.name),
      }),
    ];
  });
}

/**
 * Creates one slot-collision diagnostic with shared wording.
 */
export function createSlotCollisionDiagnostic(
  directoryPath: string,
  slotLogicalPath: string,
  fileNames: readonly string[],
): DiscoverDiagnostic {
  return createDiscoverErrorDiagnostic({
    code: DISCOVER_SLOT_COLLISION,
    message: `Found conflicting authored sources for "${slotLogicalPath}": ${formatQuotedFileList(fileNames)}.`,
    sourcePath: directoryPath,
  });
}

/**
 * Creates one module-slot collision diagnostic with shared wording.
 */
export function createModuleSlotCollisionDiagnostic(
  directoryPath: string,
  slotLogicalPath: string,
  fileNames: readonly string[],
): DiscoverDiagnostic {
  return createDiscoverErrorDiagnostic({
    code: DISCOVER_MODULE_SLOT_COLLISION,
    message: `Found multiple authored module sources for "${slotLogicalPath}": ${formatQuotedFileList(fileNames)}.`,
    sourcePath: directoryPath,
  });
}

function formatQuotedFileList(fileNames: readonly string[]): string {
  return fileNames.map((fileName) => `"${fileName}"`).join(", ");
}
