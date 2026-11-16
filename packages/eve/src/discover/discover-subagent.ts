import { join, relative, resolve } from "node:path";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverAgentRoot } from "#discover/discover-agent.js";
import { getSupportedModuleBaseName, normalizeLogicalPath } from "#discover/filesystem.js";
import { readSortedDirectoryEntries } from "#discover/grammar.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  type LocalSubagentSourceRef,
  type SubagentSourceRef,
} from "#discover/manifest.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";

/**
 * Diagnostics emitted while discovering subagent source graphs.
 */
export const DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID =
  "discover/local-subagent-schedules-invalid";
export const DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING =
  "discover/required-subagent-config-module-missing";
const DISCOVER_SUBAGENTS_DIRECTORY_INVALID = "discover/subagents-directory-invalid";

/**
 * Input for discovering subagent entries beneath one authored source root.
 */
interface DiscoverSubagentsInput {
  agentRoot: string;
  appRoot: string;
  /**
   * Optional {@link ProjectSource} used for all filesystem reads. Defaults
   * to a disk-backed source so disk callers keep their current behaviour.
   */
  source?: ProjectSource;
  subagentsDirectoryPath?: string;
  subagentsLogicalPath?: string;
}

/**
 * Result of discovering local subagent packages.
 */
interface DiscoverSubagentsResult {
  diagnostics: DiscoverDiagnostic[];
  subagents: SubagentSourceRef[];
}

/**
 * Discovers local subagent packages recursively without importing authored
 * modules.
 */
export async function discoverSubagents(
  input: DiscoverSubagentsInput,
): Promise<DiscoverSubagentsResult> {
  const source = input.source ?? createDiskProjectSource();
  const agentRoot = resolve(input.agentRoot);
  const subagentsDirectoryPath = resolve(
    input.subagentsDirectoryPath ?? join(agentRoot, "subagents"),
  );
  const subagentsLogicalPath = normalizeLogicalPath(
    input.subagentsLogicalPath ?? relative(agentRoot, subagentsDirectoryPath),
  );
  const subagentsDirectoryType = await source.stat(subagentsDirectoryPath);

  if (subagentsDirectoryType === "missing") {
    return {
      diagnostics: [],
      subagents: [],
    };
  }

  if (subagentsDirectoryType !== "directory") {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_SUBAGENTS_DIRECTORY_INVALID,
          message: `Expected "${subagentsDirectoryPath}" to be a directory of authored subagents.`,
          sourcePath: subagentsDirectoryPath,
        }),
      ],
      subagents: [],
    };
  }

  const entries = await readSortedDirectoryEntries(source, subagentsDirectoryPath);
  const diagnostics: DiscoverDiagnostic[] = [];
  const subagents: SubagentSourceRef[] = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      const subagentId = getSupportedModuleBaseName(entry.name);

      if (subagentId === null) {
        continue;
      }

      subagents.push(
        discoverSingleFileSubagent({
          agentRoot,
          appRoot: input.appRoot,
          subagentId,
          subagentLogicalPath: join(subagentsLogicalPath, entry.name),
          subagentPath: join(subagentsDirectoryPath, entry.name),
        }),
      );
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const localSubagentResult = await discoverLocalSubagentPackage({
      appRoot: input.appRoot,
      source,
      subagentId: entry.name,
      subagentLogicalPath: join(subagentsLogicalPath, entry.name),
      subagentRoot: join(subagentsDirectoryPath, entry.name),
    });

    diagnostics.push(...localSubagentResult.diagnostics);
    subagents.push(localSubagentResult.subagent);
  }

  return {
    diagnostics,
    subagents,
  };
}

function discoverSingleFileSubagent(input: {
  agentRoot: string;
  appRoot: string;
  subagentId: string;
  subagentLogicalPath: string;
  subagentPath: string;
}): LocalSubagentSourceRef {
  const configModule = createModuleSourceRef({
    logicalPath: input.subagentLogicalPath,
  });
  const manifest = createAgentSourceManifest({
    agentId: input.subagentId,
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    configModule,
  });

  return createLocalSubagentSourceRef({
    entryPath: input.subagentPath,
    logicalPath: input.subagentLogicalPath,
    manifest,
    rootPath: input.agentRoot,
    subagentId: input.subagentId,
  });
}

async function discoverLocalSubagentPackage(input: {
  appRoot: string;
  source: ProjectSource;
  subagentId: string;
  subagentLogicalPath: string;
  subagentRoot: string;
}): Promise<{
  diagnostics: DiscoverDiagnostic[];
  subagent: LocalSubagentSourceRef;
}> {
  const { diagnostics, manifest } = await discoverAgentRoot({
    appRoot: input.appRoot,
    role: "subagent",
    rootPath: input.subagentRoot,
    source: input.source,
  });
  return {
    diagnostics,
    subagent: createLocalSubagentSourceRef({
      entryPath: input.subagentRoot,
      logicalPath: input.subagentLogicalPath,
      manifest,
      rootPath: input.subagentRoot,
      subagentId: input.subagentId,
    }),
  };
}
