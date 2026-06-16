import { join, relative, resolve } from "node:path";
import { discoverConnectionSources } from "#discover/connections.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  classifyLocalSubagentEntry,
  getDirectoryEntryType,
  getSupportedModuleBaseName,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import {
  createHookNameDiagnostic,
  createToolNameDiagnostic,
  createUnsupportedRootDirectoryDiagnostics,
  DISCOVER_TOOLS_DIRECTORY_INVALID,
  discoverFlatModuleSource,
  discoverInstructionsSource,
  discoverNamedSourceDirectory,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { DISCOVER_HOOKS_DIRECTORY_INVALID } from "#discover/grammar.js";
import { discoverLibSources } from "#discover/lib.js";
import {
  type CreateAgentSourceManifestInput,
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  type LocalSubagentSourceRef,
  type SubagentSourceRef,
} from "#discover/manifest.js";
import {
  createDiskProjectSource,
  type ProjectSource,
  type ProjectSourceEntry,
} from "#discover/project-source.js";
import { discoverSandboxSource } from "#discover/sandbox.js";
import { discoverSkills } from "#discover/skills.js";

/**
 * Diagnostics emitted while discovering subagent source graphs.
 */
export const DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID =
  "discover/local-subagent-schedules-invalid";
export const DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING =
  "discover/required-subagent-config-module-missing";
export const DISCOVER_SUBAGENTS_DIRECTORY_INVALID = "discover/subagents-directory-invalid";

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
  const diagnostics: DiscoverDiagnostic[] = [];
  const rootEntries = await readSortedDirectoryEntries(input.source, input.subagentRoot);

  diagnostics.push(
    ...createUnsupportedRootDirectoryDiagnostics({
      classifyEntry: classifyLocalSubagentEntry,
      createUnsupportedDirectoryMessage(directoryName) {
        return `Ignoring unsupported directory "${directoryName}/" in the local subagent root.`;
      },
      rootEntries,
      rootPath: input.subagentRoot,
    }),
  );

  const instructionsResult = await discoverInstructionsSource({
    required: false,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...instructionsResult.diagnostics);

  const configModuleResult = discoverFlatModuleSource({
    missingDiagnostic: {
      code: DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING,
      message:
        'Expected one authored subagent config module at "agent.ts", "agent.cts", "agent.mts", "agent.js", "agent.cjs", or "agent.mjs".',
    },
    rootEntries,
    rootPath: input.subagentRoot,
    slotName: "agent",
  });
  diagnostics.push(...configModuleResult.diagnostics);

  const connectionsResult = await discoverConnectionSources({
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...connectionsResult.diagnostics);

  const sandboxResult = await discoverSandboxSource({
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...sandboxResult.diagnostics);

  const toolsResult = await discoverNamedSourceDirectory({
    directoryName: "tools",
    invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.subagentRoot, "tools")}" to be a directory of authored tools.`,
    recursive: true,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
    validateSegment: createToolNameDiagnostic,
  });
  diagnostics.push(...toolsResult.diagnostics);

  const hooksResult = await discoverNamedSourceDirectory({
    directoryName: "hooks",
    invalidDirectoryCode: DISCOVER_HOOKS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.subagentRoot, "hooks")}" to be a directory of authored hooks.`,
    recursive: true,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
    validateSegment: createHookNameDiagnostic,
  });
  diagnostics.push(...hooksResult.diagnostics);

  const libResult = await discoverLibSources({
    agentRoot: input.subagentRoot,
    rootEntries,
    source: input.source,
  });
  diagnostics.push(...libResult.diagnostics);

  diagnostics.push(...createLocalSubagentScheduleDiagnostics(input.subagentRoot, rootEntries));

  const skillsResult = await discoverSkills({
    agentRoot: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...skillsResult.diagnostics);

  const subagentsResult = await discoverSubagents({
    agentRoot: input.subagentRoot,
    appRoot: input.appRoot,
    source: input.source,
  });
  diagnostics.push(...subagentsResult.diagnostics);

  const manifestInput: CreateAgentSourceManifestInput = {
    agentRoot: input.subagentRoot,
    appRoot: input.appRoot,
    connections: connectionsResult.connections,
    diagnostics,
    hooks: hooksResult.sources,
    lib: libResult.lib,
    instructions: instructionsResult.instructions,
    sandbox: sandboxResult.sandbox,
    sandboxWorkspaces:
      sandboxResult.sandboxWorkspace === null ? [] : [sandboxResult.sandboxWorkspace],
    skills: skillsResult.skills,
    tools: toolsResult.sources,
    subagents: subagentsResult.subagents,
  };

  if (configModuleResult.module !== undefined) {
    manifestInput.configModule = configModuleResult.module;
  }

  const manifest = createAgentSourceManifest(manifestInput);

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

function createLocalSubagentScheduleDiagnostics(
  subagentRoot: string,
  rootEntries: readonly ProjectSourceEntry[],
): DiscoverDiagnostic[] {
  return rootEntries.flatMap((entry) => {
    if (
      classifyLocalSubagentEntry(entry.name, getDirectoryEntryType(entry)) !==
      "invalid-schedules-directory"
    ) {
      return [];
    }

    return [
      createDiscoverErrorDiagnostic({
        code: DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
        message: `Local subagent packages cannot define schedules at "${join(subagentRoot, entry.name)}".`,
        sourcePath: join(subagentRoot, entry.name),
      }),
    ];
  });
}
