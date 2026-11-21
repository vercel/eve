import { join } from "node:path";

import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import { lowerInstructionsMarkdown } from "#internal/helpers/markdown.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import {
  createDiscoverErrorDiagnostic,
  createDiscoverWarningDiagnostic,
  type DiscoverDiagnostic,
} from "#discover/diagnostics.js";
import {
  type DirectoryEntryType,
  getDirectoryEntryType,
  isAuthoredTestPath,
} from "#discover/filesystem.js";
import { closestName } from "#shared/closest-name.js";
import { type InstructionsSourceRef, createModuleSourceRef } from "#discover/manifest.js";
import { discoverMarkdownSource } from "#discover/markdown.js";
import { discoverNamedSourceDirectory } from "#discover/named-source-directory.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import { collectFlatSlotCandidates } from "#discover/slots.js";

export const DISCOVER_MODULE_SLOT_COLLISION = "discover/module-slot-collision";

export const DISCOVER_REQUIRED_INSTRUCTIONS_MISSING = "discover/required-instructions-missing";

export const DISCOVER_DEPRECATED_SYSTEM_SLOT = "discover/deprecated-system-slot";

export const DISCOVER_SLOT_COLLISION = "discover/slot-collision";

export const DISCOVER_TOOLS_DIRECTORY_INVALID = "discover/tools-directory-invalid";

export const DISCOVER_HOOKS_DIRECTORY_INVALID = "discover/hooks-directory-invalid";

export const DISCOVER_CHANNELS_DIRECTORY_INVALID = "discover/channels-directory-invalid";

export const DISCOVER_EXTENSIONS_DIRECTORY_INVALID = "discover/extensions-directory-invalid";

export const DISCOVER_TOOL_NAME_INVALID = "discover/tool-name-invalid";

const DISCOVER_CONNECTION_NAME_INVALID = "discover/connection-name-invalid";

export const DISCOVER_SANDBOX_DIRECTORY_INVALID = "discover/sandbox-directory-invalid";

const DISCOVER_INSTRUCTIONS_DIRECTORY_INVALID = "discover/instructions-directory-invalid";

const DISCOVER_CHANNEL_NAME_INVALID = "discover/channel-name-invalid";

export const DISCOVER_HOOK_NAME_INVALID = "discover/hook-name-invalid";

export const DISCOVER_EXTENSION_NAME_INVALID = "discover/extension-name-invalid";

export const TOOL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const TOOL_SLUG_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.";

export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export const SKILL_NAME_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter or digit, up to 64 characters.";

export const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const CHANNEL_SLUG_PATTERN = /^(\.?[a-z][a-z0-9-]{0,63}|\[[a-zA-Z][a-zA-Z0-9_]{0,63}\])$/;

const HOOK_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const EXTENSION_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const DISCOVER_UNSUPPORTED_DIRECTORY = "discover/unsupported-directory";

export async function readSortedDirectoryEntries(
  source: ProjectSource,
  directoryPath: string,
  options: { readonly includeTests?: boolean } = {},
): Promise<ProjectSourceEntry[]> {
  const entries = (await source.readDirectory(directoryPath)).filter(
    (entry) => options.includeTests || !isAuthoredTestPath(entry.name),
  );

  entries.sort((left, right) => left.name.localeCompare(right.name));

  return entries;
}

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

  if (flatResult.diagnostics.length > 0 || flatResult.source !== undefined) {
    return {
      diagnostics: flatResult.diagnostics,
      instructions: flatResult.source !== undefined ? [flatResult.source] : [],
    };
  }

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

export function createToolNameDiagnostic(
  slotName: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  if (TOOL_SLUG_PATTERN.test(slotName)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_TOOL_NAME_INVALID,
    message: `Tool filename "${slotName}" is not a legal tool name. ${TOOL_SLUG_RULE}`,
    sourcePath,
  });
}

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

export function createExtensionNameDiagnostic(
  slotName: string,
  sourcePath: string,
): DiscoverDiagnostic | null {
  const reservation = eveNamespaceReservation(slotName);
  if (reservation !== undefined) {
    return createDiscoverErrorDiagnostic({
      code: DISCOVER_EXTENSION_NAME_INVALID,
      message: `Extension mount "${slotName}" uses the reserved name "${slotName}". Rename it; ${reservation}.`,
      sourcePath,
    });
  }
  if (EXTENSION_SLUG_PATTERN.test(slotName)) {
    return null;
  }

  return createDiscoverErrorDiagnostic({
    code: DISCOVER_EXTENSION_NAME_INVALID,
    message:
      `Extension mount filename "${slotName}" is not a legal extension namespace. ` +
      `Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.`,
    sourcePath,
  });
}

export {
  discoverNamedSourceDirectory,
  type DiscoverNamedSourceDirectoryModuleInput,
  type DiscoverNamedSourceDirectoryWithMarkdownInput,
} from "#discover/named-source-directory.js";

const AGENT_DIRECTORY_NAMES = [
  "channels",
  "connections",
  "extensions",
  "hooks",
  "instructions",
  "instrumentation",
  "lib",
  "memory",
  "sandbox",
  "schedules",
  "skills",
  "subagents",
  "tools",
];

export function createUnsupportedRootDirectoryDiagnostics(input: {
  classifyEntry: (name: string, entryType: DirectoryEntryType) => string;
  createUnsupportedDirectoryMessage: (directoryName: string) => string;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
}): DiscoverDiagnostic[] {
  const supportedDirectories = AGENT_DIRECTORY_NAMES.filter((name) => {
    const kind = input.classifyEntry(name, "directory");
    return kind !== "unknown" && !kind.startsWith("invalid-");
  });
  return input.rootEntries.flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }

    if (input.classifyEntry(entry.name, getDirectoryEntryType(entry)) !== "unknown") {
      return [];
    }

    const match = closestName(entry.name, supportedDirectories);
    return [
      createDiscoverWarningDiagnostic({
        code: DISCOVER_UNSUPPORTED_DIRECTORY,
        message: `${input.createUnsupportedDirectoryMessage(entry.name)}${match === undefined ? "" : ` Did you mean "${match}/"?`}`,
        sourcePath: join(input.rootPath, entry.name),
      }),
    ];
  });
}

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
