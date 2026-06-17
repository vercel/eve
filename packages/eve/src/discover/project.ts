import { basename, dirname, join, resolve } from "node:path";

import {
  createDiscoverErrorDiagnostic,
  DISCOVER_PROJECT_NOT_FOUND,
  type DiscoverDiagnostic,
} from "#discover/diagnostics.js";
import {
  classifyAgentRootEntry,
  type DirectoryEntryType,
  getDirectoryEntryType,
  isProjectMarkerEntry,
} from "#discover/filesystem.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";

/**
 * Supported project layouts for filesystem-based agents.
 */
export type DiscoveryProjectLayout = "flat" | "nested";

/**
 * Resolved discovery roots for the current application.
 */
export interface ResolvedDiscoveryProject {
  agentRoot: string;
  appRoot: string;
  layout: DiscoveryProjectLayout;
}

/**
 * Error raised when discovery cannot resolve an eve agent root from a
 * {@link ProjectSource}.
 */
export class DiscoveryProjectResolutionError extends Error {
  readonly diagnostic: DiscoverDiagnostic;

  constructor(diagnostic: DiscoverDiagnostic) {
    super(diagnostic.message);
    this.name = "DiscoveryProjectResolutionError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Resolves the nearest eve app root and agent root from an arbitrary
 * starting path.
 *
 * By default the resolver walks the real filesystem. Callers that want to
 * run discovery against an in-memory tree can pass a {@link ProjectSource}
 * created via `createMemoryProjectSource(...)`.
 */
export async function resolveDiscoveryProject(
  startPath: string = process.cwd(),
  options: { source?: ProjectSource } = {},
): Promise<ResolvedDiscoveryProject> {
  const source = options.source ?? createDiskProjectSource();
  const startDirectory = await resolveSearchDirectory(source, startPath);
  let currentDirectory = startDirectory;

  while (true) {
    const nestedProjectFromAgentDirectory = await tryResolveNestedProjectFromAgentDirectory(
      source,
      currentDirectory,
    );

    if (nestedProjectFromAgentDirectory !== null) {
      return nestedProjectFromAgentDirectory;
    }

    const nestedProjectFromAppRoot = await tryResolveNestedProjectFromAppRoot(
      source,
      currentDirectory,
    );

    if (nestedProjectFromAppRoot !== null) {
      return nestedProjectFromAppRoot;
    }

    if (await isFlatAgentRoot(source, currentDirectory)) {
      return {
        agentRoot: currentDirectory,
        appRoot: currentDirectory,
        layout: "flat",
      };
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  throw new DiscoveryProjectResolutionError(
    createDiscoverErrorDiagnostic({
      code: DISCOVER_PROJECT_NOT_FOUND,
      message: `Could not resolve an eve agent root from "${startDirectory}".`,
      sourcePath: startDirectory,
    }),
  );
}

async function resolveSearchDirectory(source: ProjectSource, startPath: string): Promise<string> {
  const resolvedPath = resolve(startPath);
  const kind = await source.stat(resolvedPath);

  if (kind === "directory") {
    return resolvedPath;
  }

  return dirname(resolvedPath);
}

async function tryResolveNestedProjectFromAgentDirectory(
  source: ProjectSource,
  directoryPath: string,
): Promise<ResolvedDiscoveryProject | null> {
  if (basename(directoryPath) !== "agent") {
    return null;
  }

  const parentDirectory = dirname(directoryPath);

  if (!(await hasProjectMarkers(source, parentDirectory))) {
    return null;
  }

  return {
    agentRoot: directoryPath,
    appRoot: parentDirectory,
    layout: "nested",
  };
}

async function tryResolveNestedProjectFromAppRoot(
  source: ProjectSource,
  directoryPath: string,
): Promise<ResolvedDiscoveryProject | null> {
  if (!(await hasProjectMarkers(source, directoryPath))) {
    return null;
  }

  const agentDirectory = join(directoryPath, "agent");

  if (!(await directoryExists(source, agentDirectory))) {
    return null;
  }

  return {
    agentRoot: agentDirectory,
    appRoot: directoryPath,
    layout: "nested",
  };
}

async function isFlatAgentRoot(source: ProjectSource, directoryPath: string): Promise<boolean> {
  const entries = await readDirectoryEntryTypes(source, directoryPath);

  return Array.from(entries.entries()).some(([name, entryType]) => {
    const entryKind = classifyAgentRootEntry(name, entryType);
    return entryKind !== "unknown" && entryKind !== "lib-directory";
  });
}

async function hasProjectMarkers(source: ProjectSource, directoryPath: string): Promise<boolean> {
  const entries = await readDirectoryEntryTypes(source, directoryPath);

  return Array.from(entries.entries()).some(([name, entryType]) => {
    return isProjectMarkerEntry(name, entryType);
  });
}

async function readDirectoryEntryTypes(
  source: ProjectSource,
  directoryPath: string,
): Promise<Map<string, DirectoryEntryType>> {
  if ((await source.stat(directoryPath)) !== "directory") {
    return new Map();
  }

  const entries = await source.readDirectory(directoryPath);

  return new Map(
    entries.map((entry) => {
      return [entry.name, getDirectoryEntryType(entry)] as const;
    }),
  );
}

async function directoryExists(source: ProjectSource, directoryPath: string): Promise<boolean> {
  return (await source.stat(directoryPath)) === "directory";
}
