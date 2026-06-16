import { join } from "node:path";

import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import {
  createConnectionNameDiagnostic,
  createModuleSlotCollisionDiagnostic,
  DISCOVER_MODULE_SLOT_COLLISION,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { type ConnectionSourceRef, createConnectionSourceRef } from "#discover/manifest.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";
import { collectNamedSlotCandidates } from "#discover/slots.js";

/**
 * Shared diagnostic emitted when the authored `connections/` root is not a
 * directory.
 */
export const DISCOVER_CONNECTIONS_DIRECTORY_INVALID = "discover/connections-directory-invalid";

/**
 * Discovery diagnostic emitted when a connection exists in both file form
 * (`connections/<name>.ts`) and folder form (`connections/<name>/`).
 */
export const DISCOVER_CONNECTION_FILE_FOLDER_COLLISION =
  "discover/connection-file-folder-collision";

/**
 * Discovery diagnostic emitted when a folder-form connection contains no
 * `connection.ts` definition module.
 */
export const DISCOVER_CONNECTION_FOLDER_EMPTY = "discover/connection-folder-empty";

/**
 * Filename of the connection definition module inside a folder-form
 * connection.
 */
const CONNECTION_DEFINITION_BASE_NAME = "connection";

/**
 * Result of discovering authored connection sources from a single agent root.
 */
interface DiscoverConnectionSourcesResult {
  connections: ConnectionSourceRef[];
  diagnostics: DiscoverDiagnostic[];
}

/**
 * Discovers authored connections under `agent/connections/`.
 */
export async function discoverConnectionSources(input: {
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
}): Promise<DiscoverConnectionSourcesResult> {
  const directoryName = "connections";
  const directoryPath = join(input.rootPath, directoryName);
  const directoryEntry = input.rootEntries.find((entry) => entry.name === directoryName);

  if (directoryEntry === undefined) {
    return {
      connections: [],
      diagnostics: [],
    };
  }

  if (!directoryEntry.isDirectory()) {
    return {
      connections: [],
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_CONNECTIONS_DIRECTORY_INVALID,
          message: `Expected "${directoryPath}" to be a directory of authored connections.`,
          sourcePath: directoryPath,
        }),
      ],
    };
  }

  const directoryEntries = await readSortedDirectoryEntries(input.source, directoryPath);
  const connections: ConnectionSourceRef[] = [];
  const diagnostics: DiscoverDiagnostic[] = [];

  const fileFormNames = new Set<string>();
  for (const candidates of collectNamedSlotCandidates(directoryEntries, {
    allowMarkdown: false,
    allowModules: true,
  })) {
    const slotLogicalPath = normalizeLogicalPath(join(directoryName, candidates.slotName));

    if (candidates.moduleFileNames.length > 1) {
      fileFormNames.add(candidates.slotName);
      diagnostics.push(
        createModuleSlotCollisionDiagnostic(
          directoryPath,
          slotLogicalPath,
          candidates.moduleFileNames,
        ),
      );
      continue;
    }

    const [moduleFileName] = candidates.moduleFileNames;
    if (moduleFileName === undefined) {
      continue;
    }

    fileFormNames.add(candidates.slotName);

    const slotDiagnostic = createConnectionNameDiagnostic(
      candidates.slotName,
      join(directoryPath, moduleFileName),
    );

    if (slotDiagnostic !== null) {
      diagnostics.push(slotDiagnostic);
      continue;
    }

    connections.push(
      createConnectionSourceRef({
        connectionName: candidates.slotName,
        logicalPath: join(directoryName, moduleFileName),
      }),
    );
  }

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const connectionName = entry.name;
    const folderPath = join(directoryPath, connectionName);

    if (fileFormNames.has(connectionName)) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_CONNECTION_FILE_FOLDER_COLLISION,
          message:
            `Connection "${connectionName}" is defined twice. ` +
            `Found both file-form "connections/${connectionName}.ts" and folder-form "connections/${connectionName}/". ` +
            `Use one form, not both.`,
          sourcePath: folderPath,
        }),
      );
      const existingIndex = connections.findIndex(
        (connection) => connection.connectionName === connectionName,
      );
      if (existingIndex !== -1) {
        connections.splice(existingIndex, 1);
      }
      continue;
    }

    const slotDiagnostic = createConnectionNameDiagnostic(connectionName, folderPath);
    if (slotDiagnostic !== null) {
      diagnostics.push(slotDiagnostic);
      continue;
    }

    const folderEntries = await readSortedDirectoryEntries(input.source, folderPath);
    const moduleCandidates = collectFolderConnectionModuleCandidates(folderEntries);

    if (moduleCandidates.length > 1) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_MODULE_SLOT_COLLISION,
          message:
            `Found multiple connection definition modules inside "${normalizeLogicalPath(join(directoryName, connectionName))}": ` +
            moduleCandidates.map((name) => `"${name}"`).join(", "),
          sourcePath: folderPath,
        }),
      );
      continue;
    }

    const [moduleFileName] = moduleCandidates;

    if (moduleFileName === undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_CONNECTION_FOLDER_EMPTY,
          message:
            `Connection folder "connections/${connectionName}/" contains no "connection.ts" definition. ` +
            `Add "connections/${connectionName}/connection.ts" or use the file form "connections/${connectionName}.ts".`,
          sourcePath: folderPath,
        }),
      );
      continue;
    }

    connections.push(
      createConnectionSourceRef({
        connectionName,
        logicalPath: join(directoryName, connectionName, moduleFileName),
      }),
    );
  }

  return {
    connections,
    diagnostics,
  };
}

/**
 * Returns the file names inside a folder-form connection that match the
 * `connection.ts` definition slot.
 */
function collectFolderConnectionModuleCandidates(
  entries: readonly ProjectSourceEntry[],
): readonly string[] {
  const moduleEntries = entries.filter((entry) => entry.isFile());
  const candidates: string[] = [];

  for (const candidate of collectNamedSlotCandidates(moduleEntries, {
    allowMarkdown: false,
    allowModules: true,
  })) {
    if (candidate.slotName === CONNECTION_DEFINITION_BASE_NAME) {
      candidates.push(...candidate.moduleFileNames);
    }
  }

  return candidates;
}
