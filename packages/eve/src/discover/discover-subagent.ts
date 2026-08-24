import { join, relative, resolve } from "node:path";
import { discoverConnectionSources } from "#discover/connections.js";
import {
  createCompilerErrorDiagnostic,
  type CompilerDiagnostic,
} from "#shared/compiler-diagnostics.js";
import {
  discoverExtensionMountDeclarations,
  resolveExtensionMounts,
} from "#discover/discover-agent.js";
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
import { createCompiledSubagentNodeId } from "#compiler/compiled-agent-node-id.js";

/**
 * Diagnostics emitted while discovering subagent source graphs.
 */
export const DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID =
  "discover/local-subagent-schedules-invalid";
export const DISCOVER_SUBAGENTS_DIRECTORY_INVALID = "discover/subagents-directory-invalid";

/**
 * Input for discovering subagent entries beneath one authored source root.
 */
interface DiscoverSubagentsInput {
  agentRoot: string;
  appRoot: string;
  parentNodeId: string;
  /**
   * Optional {@link ProjectSource} used for all filesystem reads. Defaults
   * to a disk-backed source so disk callers keep their current behaviour.
   */
  source?: ProjectSource;
  subagentsDirectoryPath?: string;
  subagentsLogicalPath?: string;
  sourceIdPrefix?: string;
}

/**
 * Result of discovering local subagent packages.
 */
interface DiscoverSubagentsResult {
  diagnostics: CompilerDiagnostic[];
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
  const { parentNodeId } = input;
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
        createCompilerErrorDiagnostic({
          code: DISCOVER_SUBAGENTS_DIRECTORY_INVALID,
          message: `Expected "${subagentsDirectoryPath}" to be a directory of authored subagents.`,
          nodeId: parentNodeId,
          sourcePath: subagentsDirectoryPath,
        }),
      ],
      subagents: [],
    };
  }

  const entries = await readSortedDirectoryEntries(source, subagentsDirectoryPath);
  const diagnostics: CompilerDiagnostic[] = [];
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

    const localSubagentInput = {
      appRoot: input.appRoot,
      nodeId: createCompiledSubagentNodeId(
        parentNodeId,
        scopeSourceId(
          normalizeLogicalPath(join(subagentsLogicalPath, entry.name)),
          input.sourceIdPrefix,
        ),
      ),
      source,
      subagentId: entry.name,
      subagentLogicalPath: join(subagentsLogicalPath, entry.name),
      subagentRoot: join(subagentsDirectoryPath, entry.name),
    };
    const localSubagentResult = await discoverLocalSubagentPackage(
      input.sourceIdPrefix === undefined
        ? localSubagentInput
        : { ...localSubagentInput, sourceIdPrefix: input.sourceIdPrefix },
    );

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
  nodeId: string;
  source: ProjectSource;
  sourceIdPrefix?: string;
  subagentId: string;
  subagentLogicalPath: string;
  subagentRoot: string;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  subagent: LocalSubagentSourceRef;
}> {
  const diagnostics: CompilerDiagnostic[] = [];
  const rootEntries = await readSortedDirectoryEntries(input.source, input.subagentRoot);

  diagnostics.push(
    ...createUnsupportedRootDirectoryDiagnostics({
      classifyEntry: classifyLocalSubagentEntry,
      createUnsupportedDirectoryMessage(directoryName) {
        return `Ignoring unsupported directory "${directoryName}/" in the local subagent root.`;
      },
      nodeId: input.nodeId,
      rootEntries,
      rootPath: input.subagentRoot,
    }),
  );

  const instructionsResult = await discoverInstructionsSource({
    nodeId: input.nodeId,
    required: false,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...instructionsResult.diagnostics);

  const configModuleResult = discoverFlatModuleSource({
    nodeId: input.nodeId,
    rootEntries,
    rootPath: input.subagentRoot,
    slotName: "agent",
  });
  diagnostics.push(...configModuleResult.diagnostics);

  const connectionsResult = await discoverConnectionSources({
    nodeId: input.nodeId,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...connectionsResult.diagnostics);

  const sandboxResult = await discoverSandboxSource({
    nodeId: input.nodeId,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
  });
  diagnostics.push(...sandboxResult.diagnostics);

  const toolsResult = await discoverNamedSourceDirectory({
    directoryName: "tools",
    invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.subagentRoot, "tools")}" to be a directory of authored tools.`,
    nodeId: input.nodeId,
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
    nodeId: input.nodeId,
    recursive: true,
    rootEntries,
    rootPath: input.subagentRoot,
    source: input.source,
    validateSegment: createHookNameDiagnostic,
  });
  diagnostics.push(...hooksResult.diagnostics);

  const libResult = await discoverLibSources({
    agentRoot: input.subagentRoot,
    nodeId: input.nodeId,
    rootEntries,
    source: input.source,
  });
  diagnostics.push(...libResult.diagnostics);

  diagnostics.push(
    ...createLocalSubagentScheduleDiagnostics(input.subagentRoot, input.nodeId, rootEntries),
  );

  const skillsResult = await discoverSkills({
    agentRoot: input.subagentRoot,
    nodeId: input.nodeId,
    source: input.source,
  });
  diagnostics.push(...skillsResult.diagnostics);

  const subagentsInput = {
    agentRoot: input.subagentRoot,
    appRoot: input.appRoot,
    parentNodeId: input.nodeId,
    source: input.source,
  };
  const subagentsResult = await discoverSubagents(
    input.sourceIdPrefix === undefined
      ? subagentsInput
      : { ...subagentsInput, sourceIdPrefix: input.sourceIdPrefix },
  );
  diagnostics.push(...subagentsResult.diagnostics);

  const extensionsResult = await discoverExtensionMountDeclarations({
    agentRoot: input.subagentRoot,
    nodeId: input.nodeId,
    source: input.source,
  });
  diagnostics.push(...extensionsResult.diagnostics);

  const resolvedExtensions = await resolveExtensionMounts({
    agentRoot: input.subagentRoot,
    appRoot: input.appRoot,
    mounts: extensionsResult.mounts,
    nodeId: input.nodeId,
    source: input.source,
  });
  diagnostics.push(...resolvedExtensions.diagnostics);

  const manifestInput: CreateAgentSourceManifestInput = {
    agentRoot: input.subagentRoot,
    appRoot: input.appRoot,
    connections: connectionsResult.connections,
    diagnostics,
    extensions: extensionsResult.mounts.map((mount) => mount.mountRef),
    resolvedExtensions: resolvedExtensions.mounts,
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
  nodeId: string,
  rootEntries: readonly ProjectSourceEntry[],
): CompilerDiagnostic[] {
  return rootEntries.flatMap((entry) => {
    if (
      classifyLocalSubagentEntry(entry.name, getDirectoryEntryType(entry)) !==
      "invalid-schedules-directory"
    ) {
      return [];
    }

    return [
      createCompilerErrorDiagnostic({
        code: DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
        message: `Local subagent packages cannot define schedules at "${join(subagentRoot, entry.name)}".`,
        nodeId,
        sourcePath: join(subagentRoot, entry.name),
      }),
    ];
  });
}

function scopeSourceId(sourceId: string, prefix: string | undefined): string {
  return prefix === undefined ? sourceId : `${prefix}:${sourceId}`;
}
