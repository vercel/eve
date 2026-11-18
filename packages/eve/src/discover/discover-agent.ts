import { join, resolve } from "node:path";

import { discoverConnectionSources } from "#discover/connections.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
  DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING,
  discoverSubagents,
} from "#discover/discover-subagent.js";
import {
  DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  DISCOVER_EXTENSION_INSTRUMENTATION_UNSUPPORTED,
  DISCOVER_EXTENSION_MEMORY_UNSUPPORTED,
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
  locateExtensionMount,
  mountNamespace,
} from "#discover/extensions.js";
import {
  classifyAgentRootEntry,
  classifyLocalSubagentEntry,
  getDirectoryEntryType,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import {
  createChannelNameDiagnostic,
  createExtensionNameDiagnostic,
  createHookNameDiagnostic,
  createToolNameDiagnostic,
  createUnsupportedRootEntryDiagnostics,
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
import { discoverMemorySources } from "#discover/memory.js";
import {
  type AgentSourceManifest,
  type AgentSourceRef,
  createAgentSourceManifest,
  createModuleSourceRef,
  type ExtensionSourceRef,
  type ResolvedExtensionMount,
  sourceKindOf,
  sourcesOf,
} from "#discover/manifest.js";
import {
  createDiskProjectSource,
  type ProjectSource,
  type ProjectSourceEntry,
  readPackageJsonName,
} from "#discover/project-source.js";
import { discoverSandboxSource } from "#discover/sandbox.js";
import { discoverScheduleSources } from "#discover/schedules.js";
import { discoverSkills } from "#discover/skills.js";
import { stripNpmPackageScope } from "#shared/package-name.js";

interface DiscoverAgentInput {
  agentRoot: string;
  appRoot: string;
  source?: ProjectSource;
  role?: "agent" | "extension";
}

interface DiscoverAgentResult {
  diagnostics: DiscoverDiagnostic[];
  manifest: AgentSourceManifest;
}

export async function discoverAgent(input: DiscoverAgentInput): Promise<DiscoverAgentResult> {
  const source = input.source ?? createDiskProjectSource();
  const appRoot = resolve(input.appRoot);
  return discoverAgentRoot({
    appRoot,
    packageName: await tryReadPackageJsonName(source, appRoot),
    role: input.role ?? "agent",
    rootPath: resolve(input.agentRoot),
    source,
  });
}

const CONSUMER_OWNED = [
  {
    code: DISCOVER_EXTENSION_MEMORY_UNSUPPORTED,
    kind: "memory",
    message:
      "An extension may not declare memory — scope and lifecycle state belong to the consuming application.",
  },
  {
    code: DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
    kind: "sandbox",
    message: "An extension may not declare a sandbox — it is the consuming agent's to own.",
  },
] as const;

export async function discoverAgentRoot(input: {
  readonly appRoot: string;
  readonly packageName?: string;
  readonly role: "agent" | "extension" | "subagent";
  readonly rootPath: string;
  readonly source: ProjectSource;
}): Promise<DiscoverAgentResult> {
  const { appRoot, role, rootPath, source } = input;
  const diagnostics: DiscoverDiagnostic[] = [];
  const found = <T extends { readonly diagnostics: readonly DiscoverDiagnostic[] }>(result: T) => {
    diagnostics.push(...result.diagnostics);
    return result;
  };
  const rootEntries = await readSortedDirectoryEntries(source, rootPath);
  const subagent = role === "subagent";

  diagnostics.push(
    ...createUnsupportedRootEntryDiagnostics({
      classifyEntry: subagent ? classifyLocalSubagentEntry : classifyAgentRootEntry,
      rootEntries,
      rootLabel: subagent ? "local subagent" : "agent",
      rootPath,
    }),
  );

  const { instructions } = found(
    await discoverInstructionsSource({ required: role === "agent", rootEntries, rootPath, source }),
  );
  const config = found(
    discoverFlatModuleSource({
      ...(subagent && {
        missingDiagnostic: {
          code: DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING,
          message:
            'Expected one authored subagent config module at "agent.ts", "agent.cts", "agent.mts", "agent.js", "agent.cjs", or "agent.mjs".',
        },
      }),
      rootEntries,
      rootPath,
      slotName: "agent",
    }),
  ).module;
  const channels = subagent
    ? []
    : found(
        await discoverNamedSourceDirectory({
          directoryName: "channels",
          invalidDirectoryCode: DISCOVER_CHANNELS_DIRECTORY_INVALID,
          invalidDirectoryMessage: `Expected "${join(rootPath, "channels")}" to be a directory of authored channels.`,
          recursive: true,
          rootEntries,
          rootPath,
          source,
          validateSegment: createChannelNameDiagnostic,
        }),
      ).sources;
  const { lib } = found(await discoverLibSources({ agentRoot: rootPath, rootEntries, source }));
  if (subagent) diagnostics.push(...createLocalSubagentScheduleDiagnostics(rootPath, rootEntries));
  const schedules = subagent
    ? []
    : found(await discoverScheduleSources({ agentRoot: rootPath, rootEntries, source })).schedules;
  const { connections } = found(await discoverConnectionSources({ rootEntries, rootPath, source }));
  const { memories } = found(await discoverMemorySources({ rootEntries, rootPath, source }));
  const sandbox = found(await discoverSandboxSource({ rootEntries, rootPath, source }));
  const tools = found(
    await discoverNamedSourceDirectory({
      directoryName: "tools",
      invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
      invalidDirectoryMessage: `Expected "${join(rootPath, "tools")}" to be a directory of authored tools.`,
      recursive: true,
      rootEntries,
      rootPath,
      source,
      validateSegment: createToolNameDiagnostic,
      warnOnJsxModules: true,
    }),
  ).sources;
  const hooks = found(
    await discoverNamedSourceDirectory({
      directoryName: "hooks",
      invalidDirectoryCode: DISCOVER_HOOKS_DIRECTORY_INVALID,
      invalidDirectoryMessage: `Expected "${join(rootPath, "hooks")}" to be a directory of authored hooks.`,
      recursive: true,
      rootEntries,
      rootPath,
      source,
      validateSegment: createHookNameDiagnostic,
      warnOnJsxModules: true,
    }),
  ).sources;
  const { skills } = found(await discoverSkills({ agentRoot: rootPath, source }));
  const { subagents } = found(await discoverSubagents({ agentRoot: rootPath, appRoot, source }));
  const { mounts } = found(
    await discoverExtensionMountDeclarations({ agentRoot: rootPath, source }),
  );

  let sources: AgentSourceRef[] = [
    ...channels,
    ...connections,
    ...hooks,
    ...memories,
    ...(sandbox.sandbox === null ? [] : [sandbox.sandbox]),
    ...tools,
    ...instructions,
    ...schedules,
    ...skills,
  ];
  let resolvedExtensions: readonly ResolvedExtensionMount[] = [];
  if (role === "extension") {
    if (config !== undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
          message:
            "An extension may not declare agent config (agent.ts) — model, limits, and sandbox are the consuming agent's to own.",
          sourcePath: join(rootPath, config.logicalPath),
        }),
      );
    }
    const instrumentation = rootEntries.find(
      (entry) => entry.name === "instrumentation" && entry.isDirectory(),
    );
    if (instrumentation !== undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_INSTRUMENTATION_UNSUPPORTED,
          message:
            "An extension may not declare instrumentation providers — process-wide observability belongs to the consuming agent.",
          sourcePath: join(rootPath, instrumentation.name),
        }),
      );
    }
    for (const owned of CONSUMER_OWNED) {
      const [first] = sourcesOf({ sources }, owned.kind);
      if (first === undefined) continue;
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: owned.code,
          message: owned.message,
          sourcePath: join(rootPath, first.logicalPath),
        }),
      );
    }
    sources = sources.filter((entry) =>
      CONSUMER_OWNED.every(({ kind }) => sourceKindOf(entry.logicalPath) !== kind),
    );
    for (const descriptor of mounts) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
          message: `"${descriptor.mountRef.logicalPath}" mounts an extension from inside an extension, which is not supported yet. Extensions cannot mount other extensions; remove the "extensions/" slot.`,
          sourcePath: join(rootPath, descriptor.mountRef.logicalPath),
        }),
      );
    }
  } else {
    resolvedExtensions = found(
      await resolveExtensionMounts({ agentRoot: rootPath, appRoot, mounts, source }),
    ).mounts;
  }

  const manifest = createAgentSourceManifest({
    agentRoot: rootPath,
    appRoot,
    ...(role !== "extension" && config !== undefined && { configModule: config }),
    diagnostics,
    extensions: role === "extension" ? [] : mounts.map((descriptor) => descriptor.mountRef),
    lib,
    packageName: input.packageName,
    resolvedExtensions,
    sandboxWorkspaces:
      role === "extension" || sandbox.sandboxWorkspace === null ? [] : [sandbox.sandboxWorkspace],
    sources,
    subagents,
  });
  return { diagnostics, manifest };
}

function createLocalSubagentScheduleDiagnostics(
  subagentRoot: string,
  rootEntries: readonly ProjectSourceEntry[],
): DiscoverDiagnostic[] {
  return rootEntries.flatMap((entry) =>
    classifyLocalSubagentEntry(entry.name, getDirectoryEntryType(entry)) ===
    "invalid-schedules-directory"
      ? [
          createDiscoverErrorDiagnostic({
            code: DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
            message: `Local subagent packages cannot define schedules at "${join(subagentRoot, entry.name)}".`,
            sourcePath: join(subagentRoot, entry.name),
          }),
        ]
      : [],
  );
}

export async function resolveExtensionMounts(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly mounts: readonly ExtensionMountDescriptor[];
  readonly source: ProjectSource;
}): Promise<{
  readonly diagnostics: readonly DiscoverDiagnostic[];
  readonly mounts: readonly ResolvedExtensionMount[];
}> {
  const diagnostics: DiscoverDiagnostic[] = [];
  const mounts: ResolvedExtensionMount[] = [];

  for (const descriptor of input.mounts) {
    const located = await locateExtensionMount({
      source: input.source,
      agentRoot: input.agentRoot,
      appRoot: input.appRoot,
      mount: descriptor.mountRef,
      namespace: descriptor.namespace,
    });
    diagnostics.push(...located.diagnostics);
    if (located.location === undefined) continue;

    const extensionResult = await discoverAgent({
      agentRoot: located.location.sourceRoot,
      appRoot: located.location.packageRoot,
      source: input.source,
      role: "extension",
    });
    diagnostics.push(...extensionResult.diagnostics);

    let overrides: AgentSourceManifest | undefined;
    if (descriptor.overridesRoot !== undefined) {
      const overridesResult = await discoverAgent({
        agentRoot: descriptor.overridesRoot,
        appRoot: input.appRoot,
        source: input.source,
        role: "extension",
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
  readonly namespace: string;
  readonly mountRef: ExtensionSourceRef;
  readonly overridesRoot?: string;
}

export async function discoverExtensionMountDeclarations(input: {
  readonly agentRoot: string;
  readonly source?: ProjectSource;
}): Promise<{
  diagnostics: DiscoverDiagnostic[];
  mounts: ExtensionMountDescriptor[];
}> {
  const source = input.source ?? createDiskProjectSource();
  const agentRoot = resolve(input.agentRoot);
  const rootEntries = await readSortedDirectoryEntries(source, agentRoot);
  const extensionsResult = await discoverNamedSourceDirectory({
    directoryName: "extensions",
    invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "extensions")}" to be a directory of extension mounts.`,
    recursive: false,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createExtensionNameDiagnostic,
  });
  const collection = await collectExtensionMounts({
    agentRoot,
    fileMounts: extensionsResult.sources,
    rootEntries,
    source,
  });

  return {
    diagnostics: [...extensionsResult.diagnostics, ...collection.diagnostics],
    mounts: collection.mounts,
  };
}

async function collectExtensionMounts(input: {
  readonly agentRoot: string;
  readonly fileMounts: readonly ExtensionSourceRef[];
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly source: ProjectSource;
}): Promise<{
  diagnostics: DiscoverDiagnostic[];
  mounts: ExtensionMountDescriptor[];
}> {
  const diagnostics: DiscoverDiagnostic[] = [];
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
      const nameDiagnostic = createExtensionNameDiagnostic(namespace, mountDir);
      if (nameDiagnostic !== null) {
        diagnostics.push(nameDiagnostic);
        continue;
      }

      const declarationResult = discoverFlatModuleSource({
        rootEntries: await readSortedDirectoryEntries(input.source, mountDir),
        rootPath: mountDir,
        slotName: "extension",
      });
      diagnostics.push(...declarationResult.diagnostics);

      if (declarationResult.module === undefined) {
        diagnostics.push(
          createDiscoverErrorDiagnostic({
            code: DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
            message: `Extension mount directory "extensions/${namespace}/" must declare its mount in "extension.ts" (or another supported module extension).`,
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
      createDiscoverErrorDiagnostic({
        code: DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
        message: `Extension namespace "${namespace}" is claimed by both a file mount ("extensions/${namespace}.ts") and a directory mount ("extensions/${namespace}/"). Keep only one.`,
        sourcePath: extensionsRoot,
      }),
    );
  }

  const mounts = [...fileDescriptors, ...directoryDescriptors].filter(
    (descriptor) => !ambiguousNamespaces.has(descriptor.namespace),
  );

  return { diagnostics, mounts };
}

async function tryReadPackageJsonName(
  source: ProjectSource,
  appRoot: string,
): Promise<string | undefined> {
  const name = await readPackageJsonName(source, appRoot);
  return name === undefined ? undefined : stripNpmPackageScope(name);
}
