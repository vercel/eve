import { join, resolve } from "node:path";

import { discoverConnectionSources } from "#discover/connections.js";
import {
  createCompilerErrorDiagnostic,
  type CompilerDiagnostic,
} from "#shared/compiler-diagnostics.js";
import { discoverSubagents } from "#discover/discover-subagent.js";
import {
  DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
  locateExtensionMount,
  mountNamespace,
} from "#discover/extensions.js";
import { classifyAgentRootEntry, normalizeLogicalPath } from "#discover/filesystem.js";
import {
  createChannelNameDiagnostic,
  createExtensionNameDiagnostic,
  createHookNameDiagnostic,
  createToolNameDiagnostic,
  createUnsupportedRootDirectoryDiagnostics,
  DISCOVER_CHANNELS_DIRECTORY_INVALID,
  DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
  DISCOVER_HOOKS_DIRECTORY_INVALID,
  DISCOVER_TOOLS_DIRECTORY_INVALID,
  discoverFlatModuleSource,
  discoverInstructionsSource,
  discoverNamedSourceDirectory,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { discoverLibSources } from "#discover/lib.js";
import { discoverInstrumentationSources } from "#discover/instrumentation.js";
import {
  type AgentSourceManifest,
  type CreateAgentSourceManifestInput,
  createAgentSourceManifest,
  createModuleSourceRef,
  type ExtensionSourceRef,
  type ResolvedExtensionMount,
} from "#discover/manifest.js";
import {
  createDiskProjectSource,
  type ProjectSource,
  type ProjectSourceEntry,
} from "#discover/project-source.js";
import { discoverSandboxSource } from "#discover/sandbox.js";
import { discoverScheduleSources } from "#discover/schedules.js";
import { discoverSkills } from "#discover/skills.js";
import { stripNpmPackageScope } from "#shared/package-name.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";

/**
 * Input for discovering the authored agent source graph from resolved roots.
 */
interface DiscoverAgentInput {
  agentRoot: string;
  appRoot: string;
  /** Compiled graph node that owns diagnostics emitted for this source root. */
  nodeId?: string;
  /**
   * Optional {@link ProjectSource} used for all filesystem reads. Defaults
   * to a disk-backed source so disk callers keep their current behaviour.
   * Tests that want to run discovery against an in-memory tree pass a
   * memory-backed source.
   */
  source?: ProjectSource;
  /**
   * Discovery role. `"agent"` (default) accepts agent-level config and resolves
   * that node's mounted extensions. `"extension"` discovers an extension
   * package's source tree: it rejects `agent.ts`/`sandbox` (consumer-owned) and
   * nested extension mounts.
   */
  role?: "agent" | "extension";
  /** Prefix applied by extension composition to every nested subagent source id. */
  subagentSourceIdPrefix?: string;
}

/**
 * Result of discovering one authored agent source graph.
 */
interface DiscoverAgentResult {
  diagnostics: CompilerDiagnostic[];
  manifest: AgentSourceManifest;
}

/**
 * Discovers the current agent's authored source graph without importing authored
 * modules.
 */
export async function discoverAgent(input: DiscoverAgentInput): Promise<DiscoverAgentResult> {
  const source = input.source ?? createDiskProjectSource();
  const appRoot = resolve(input.appRoot);
  const agentRoot = resolve(input.agentRoot);
  const role = input.role ?? "agent";
  const nodeId = input.nodeId ?? ROOT_COMPILED_AGENT_NODE_ID;
  const diagnostics: CompilerDiagnostic[] = [];
  const packageName = await tryReadPackageJsonName(source, appRoot);
  const rootEntries = await readSortedDirectoryEntries(source, agentRoot);

  diagnostics.push(
    ...createUnsupportedRootDirectoryDiagnostics({
      classifyEntry: classifyAgentRootEntry,
      createUnsupportedDirectoryMessage(directoryName) {
        return `Ignoring unsupported directory "${directoryName}/" in the agent root.`;
      },
      nodeId,
      rootEntries,
      rootPath: agentRoot,
    }),
  );

  const instructionsResult = await discoverInstructionsSource({
    nodeId,
    rootEntries,
    rootPath: agentRoot,
    source,
    required: role !== "extension",
  });
  diagnostics.push(...instructionsResult.diagnostics);

  const configModuleResult = discoverFlatModuleSource({
    nodeId,
    rootEntries,
    rootPath: agentRoot,
    slotName: "agent",
  });
  diagnostics.push(...configModuleResult.diagnostics);

  const channelsResult = await discoverNamedSourceDirectory({
    directoryName: "channels",
    invalidDirectoryCode: DISCOVER_CHANNELS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "channels")}" to be a directory of authored channels.`,
    nodeId,
    recursive: true,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createChannelNameDiagnostic,
  });
  diagnostics.push(...channelsResult.diagnostics);

  const libResult = await discoverLibSources({
    agentRoot,
    nodeId,
    rootEntries,
    source,
  });
  diagnostics.push(...libResult.diagnostics);

  const schedulesResult = await discoverScheduleSources({
    agentRoot,
    nodeId,
    rootEntries,
    source,
  });
  diagnostics.push(...schedulesResult.diagnostics);

  const connectionsResult = await discoverConnectionSources({
    nodeId,
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  diagnostics.push(...connectionsResult.diagnostics);

  const sandboxResult = await discoverSandboxSource({
    nodeId,
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  diagnostics.push(...sandboxResult.diagnostics);

  const instrumentationResult = await discoverInstrumentationSources({
    nodeId,
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  diagnostics.push(...instrumentationResult.diagnostics);

  if (role === "extension") {
    if (configModuleResult.module !== undefined) {
      diagnostics.push(
        createCompilerErrorDiagnostic({
          code: DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
          message:
            "An extension may not declare agent config (agent.ts) — model, limits, and sandbox are the consuming agent's to own.",
          nodeId,
          sourcePath: join(agentRoot, configModuleResult.module.logicalPath),
        }),
      );
    }
    if (sandboxResult.sandbox !== null) {
      diagnostics.push(
        createCompilerErrorDiagnostic({
          code: DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
          message: "An extension may not declare a sandbox — it is the consuming agent's to own.",
          nodeId,
          sourcePath: join(agentRoot, sandboxResult.sandbox.logicalPath),
        }),
      );
    }
  }

  const toolsResult = await discoverNamedSourceDirectory({
    directoryName: "tools",
    invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "tools")}" to be a directory of authored tools.`,
    nodeId,
    recursive: true,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createToolNameDiagnostic,
  });
  diagnostics.push(...toolsResult.diagnostics);

  const hooksResult = await discoverNamedSourceDirectory({
    directoryName: "hooks",
    invalidDirectoryCode: DISCOVER_HOOKS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "hooks")}" to be a directory of authored hooks.`,
    nodeId,
    recursive: true,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createHookNameDiagnostic,
  });
  diagnostics.push(...hooksResult.diagnostics);

  const extensionsResult = await discoverNamedSourceDirectory({
    directoryName: "extensions",
    invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "extensions")}" to be a directory of extension mounts.`,
    nodeId,
    recursive: false,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createExtensionNameDiagnostic,
  });
  diagnostics.push(...extensionsResult.diagnostics);

  const skillsResult = await discoverSkills({
    agentRoot,
    nodeId,
    source,
  });
  diagnostics.push(...skillsResult.diagnostics);

  const subagentsResult = await discoverSubagents({
    agentRoot,
    appRoot,
    parentNodeId: nodeId,
    source,
    ...(input.subagentSourceIdPrefix === undefined
      ? {}
      : { sourceIdPrefix: input.subagentSourceIdPrefix }),
  });
  diagnostics.push(...subagentsResult.diagnostics);

  const mountCollection = await collectExtensionMounts({
    agentRoot,
    fileMounts: extensionsResult.sources,
    nodeId,
    rootEntries,
    source,
  });
  diagnostics.push(...mountCollection.diagnostics);

  let resolvedExtensions: readonly ResolvedExtensionMount[] = [];
  if (role !== "agent") {
    // Extensions cannot mount other extensions yet. Fail loudly instead of
    // silently dropping the nested mount, and reserve the behavior so enabling
    // it later is additive.
    for (const descriptor of mountCollection.mounts) {
      diagnostics.push(
        createCompilerErrorDiagnostic({
          code: DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
          message: `"${descriptor.mountRef.logicalPath}" mounts an extension from inside an extension, which is not supported yet. Extensions cannot mount other extensions; remove the "extensions/" slot.`,
          nodeId,
          sourcePath: join(agentRoot, descriptor.mountRef.logicalPath),
        }),
      );
    }
  } else {
    const result = await resolveExtensionMounts({
      agentRoot,
      appRoot,
      mounts: mountCollection.mounts,
      nodeId,
      source,
    });
    diagnostics.push(...result.diagnostics);
    resolvedExtensions = result.mounts;
  }

  const instrumentation: { file?: ModuleSourceRef; providers: readonly ModuleSourceRef[] } = {
    providers: instrumentationResult.providers,
  };
  if (instrumentationResult.file !== undefined) {
    instrumentation.file = instrumentationResult.file;
  }
  const manifestInput: CreateAgentSourceManifestInput = {
    agentRoot,
    appRoot,
    channels: channelsResult.sources,
    connections: connectionsResult.connections,
    packageName,
    diagnostics,
    extensions: mountCollection.mounts.map((descriptor) => descriptor.mountRef),
    resolvedExtensions,
    hooks: hooksResult.sources,
    instrumentation,
    lib: libResult.lib,
    instructions: instructionsResult.instructions,
    sandbox: sandboxResult.sandbox,
    sandboxWorkspaces:
      sandboxResult.sandboxWorkspace === null ? [] : [sandboxResult.sandboxWorkspace],
    schedules: schedulesResult.schedules,
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
    manifest,
  };
}

/**
 * One extension mount discovered under `agent/extensions/`, in either the flat
 * file form (`extensions/crm.ts`) or the directory form
 * (`extensions/crm/extension.ts` with optional override slots).
 */
/** Resolves extension declarations into their discovered source manifests. */
export async function resolveExtensionMounts(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly mounts: readonly ExtensionMountDescriptor[];
  readonly nodeId: string;
  readonly source: ProjectSource;
}): Promise<{
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly mounts: readonly ResolvedExtensionMount[];
}> {
  const diagnostics: CompilerDiagnostic[] = [];
  const mounts: ResolvedExtensionMount[] = [];

  for (const descriptor of input.mounts) {
    const located = await locateExtensionMount({
      source: input.source,
      agentRoot: input.agentRoot,
      appRoot: input.appRoot,
      mount: descriptor.mountRef,
      namespace: descriptor.namespace,
      nodeId: input.nodeId,
    });
    diagnostics.push(...located.diagnostics);
    if (located.location === undefined) continue;

    const extensionResult = await discoverAgent({
      agentRoot: located.location.sourceRoot,
      appRoot: located.location.packageRoot,
      nodeId: input.nodeId,
      source: input.source,
      role: "extension",
      subagentSourceIdPrefix: `ext:${descriptor.namespace}`,
    });
    diagnostics.push(...extensionResult.diagnostics);

    let overrides: AgentSourceManifest | undefined;
    if (descriptor.overridesRoot !== undefined) {
      const overridesResult = await discoverAgent({
        agentRoot: descriptor.overridesRoot,
        appRoot: input.appRoot,
        nodeId: input.nodeId,
        source: input.source,
        role: "extension",
        subagentSourceIdPrefix: `ext-override:${descriptor.namespace}`,
      });
      diagnostics.push(...overridesResult.diagnostics);
      overrides = overridesResult.manifest;
    }

    mounts.push({
      namespace: located.location.namespace,
      specifier: located.location.specifier,
      packageName: located.location.packageName,
      packageRoot: located.location.packageRoot,
      sourceRoot: located.location.sourceRoot,
      manifest: extensionResult.manifest,
      externalDependencies: located.location.externalDependencies,
      overrides,
    });
  }

  return { diagnostics, mounts };
}

export interface ExtensionMountDescriptor {
  /** Mount namespace prefixed onto every composed contribution. */
  readonly namespace: string;
  /** Module ref for the mount declaration the package specifier is read from. */
  readonly mountRef: ExtensionSourceRef;
  /**
   * Absolute path to the mount directory when this is the directory form.
   * Its override slots are discovered as an agent-shaped source. Absent for
   * the flat file form.
   */
  readonly overridesRoot?: string;
}

/**
 * Discovers extension mount declarations without resolving or inspecting their
 * package distributions. Development uses this before building local mounts.
 */
export async function discoverExtensionMountDeclarations(input: {
  readonly agentRoot: string;
  readonly nodeId: string;
  readonly source?: ProjectSource;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  mounts: ExtensionMountDescriptor[];
}> {
  const source = input.source ?? createDiskProjectSource();
  const agentRoot = resolve(input.agentRoot);
  const { nodeId } = input;
  const rootEntries = await readSortedDirectoryEntries(source, agentRoot);
  const extensionsResult = await discoverNamedSourceDirectory({
    directoryName: "extensions",
    invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "extensions")}" to be a directory of extension mounts.`,
    nodeId,
    recursive: false,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createExtensionNameDiagnostic,
  });
  const collection = await collectExtensionMounts({
    agentRoot,
    fileMounts: extensionsResult.sources,
    nodeId,
    rootEntries,
    source,
  });

  return {
    diagnostics: [...extensionsResult.diagnostics, ...collection.diagnostics],
    mounts: collection.mounts,
  };
}

/**
 * Collects extension mounts in both the flat file form and the directory form,
 * validating directory names and rejecting a namespace claimed by both forms.
 *
 * File mounts arrive pre-validated from {@link discoverNamedSourceDirectory}
 * (which, run non-recursively, ignores subdirectories); directory mounts are
 * gathered here by scanning the `extensions/` entries for subdirectories, each
 * of which must hold an `extension.<ext>` declaration.
 */
async function collectExtensionMounts(input: {
  readonly agentRoot: string;
  readonly fileMounts: readonly ExtensionSourceRef[];
  readonly nodeId: string;
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly source: ProjectSource;
}): Promise<{
  diagnostics: CompilerDiagnostic[];
  mounts: ExtensionMountDescriptor[];
}> {
  const diagnostics: CompilerDiagnostic[] = [];
  const extensionsRoot = join(input.agentRoot, "extensions");

  const fileDescriptors: ExtensionMountDescriptor[] = input.fileMounts.map((mountRef) => ({
    namespace: mountNamespace(mountRef.logicalPath),
    mountRef,
  }));
  const fileNamespaces = new Set(fileDescriptors.map((descriptor) => descriptor.namespace));

  const extensionsEntry = input.rootEntries.find((entry) => entry.name === "extensions");
  const directoryDescriptors: ExtensionMountDescriptor[] = [];
  const ambiguousNamespaces = new Set<string>();

  if (extensionsEntry?.isDirectory() === true) {
    const entries = await readSortedDirectoryEntries(input.source, extensionsRoot);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const namespace = entry.name;
      const mountDir = join(extensionsRoot, namespace);
      const nameDiagnostic = createExtensionNameDiagnostic(namespace, mountDir, input.nodeId);
      if (nameDiagnostic !== null) {
        diagnostics.push(nameDiagnostic);
        continue;
      }

      const declarationResult = discoverFlatModuleSource({
        nodeId: input.nodeId,
        rootEntries: await readSortedDirectoryEntries(input.source, mountDir),
        rootPath: mountDir,
        slotName: "extension",
      });
      diagnostics.push(...declarationResult.diagnostics);

      if (declarationResult.module === undefined) {
        diagnostics.push(
          createCompilerErrorDiagnostic({
            code: DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
            message: `Extension mount directory "extensions/${namespace}/" must declare its mount in "extension.ts" (or another supported module extension).`,
            nodeId: input.nodeId,
            sourcePath: mountDir,
          }),
        );
        continue;
      }

      if (fileNamespaces.has(namespace)) {
        ambiguousNamespaces.add(namespace);
      }

      directoryDescriptors.push({
        namespace,
        mountRef: createModuleSourceRef({
          logicalPath: normalizeLogicalPath(
            join("extensions", namespace, declarationResult.module.logicalPath),
          ),
        }),
        overridesRoot: mountDir,
      });
    }
  }

  for (const namespace of ambiguousNamespaces) {
    diagnostics.push(
      createCompilerErrorDiagnostic({
        code: DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
        message: `Extension namespace "${namespace}" is claimed by both a file mount ("extensions/${namespace}.ts") and a directory mount ("extensions/${namespace}/"). Keep only one.`,
        nodeId: input.nodeId,
        sourcePath: extensionsRoot,
      }),
    );
  }

  const mounts = [...fileDescriptors, ...directoryDescriptors].filter(
    (descriptor) => !ambiguousNamespaces.has(descriptor.namespace),
  );

  return { diagnostics, mounts };
}

/**
 * Reads the `name` field from the app root's package.json through `source`
 * and strips the npm scope prefix when present (e.g. `"@org/my-agent"` →
 * `"my-agent"`).
 *
 * Returns `undefined` when the file does not exist, cannot be parsed, or does
 * not contain a non-empty string `name` field.
 */
async function tryReadPackageJsonName(
  source: ProjectSource,
  appRoot: string,
): Promise<string | undefined> {
  try {
    const packageJsonPath = join(appRoot, "package.json");
    const content = JSON.parse(await source.readTextFile(packageJsonPath)) as {
      name?: unknown;
    };
    const name = content.name;

    if (typeof name !== "string" || name.length === 0) {
      return undefined;
    }

    return stripNpmPackageScope(name);
  } catch {
    return undefined;
  }
}
