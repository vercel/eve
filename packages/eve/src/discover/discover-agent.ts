import { join, resolve } from "node:path";

import { discoverConnectionSources } from "#discover/connections.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { discoverSubagents } from "#discover/discover-subagent.js";
import {
  DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
  DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
  DISCOVER_EXTENSION_SCHEDULE_UNSUPPORTED,
  locateExtensionMount,
  mountNamespace,
} from "#discover/extensions.js";
import {
  classifyAgentRootEntry,
  normalizeLogicalPath,
  SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS,
} from "#discover/filesystem.js";
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
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { stripNpmPackageScope } from "#shared/package-name.js";

/**
 * Input for discovering the authored agent source graph from resolved roots.
 */
interface DiscoverAgentInput {
  agentRoot: string;
  appRoot: string;
  /**
   * Optional {@link ProjectSource} used for all filesystem reads. Defaults
   * to a disk-backed source so disk callers keep their current behaviour.
   * Tests that want to run discovery against an in-memory tree pass a
   * memory-backed source.
   */
  source?: ProjectSource;
  /**
   * Discovery role. `"agent"` (default) resolves mounted extensions and
   * accepts agent-level config. `"extension"` discovers an extension's own
   * source tree: it rejects `agent.ts`/`sandbox` (consumer-owned) and does
   * not resolve further extensions (transitive mounting is a non-goal).
   */
  role?: "agent" | "extension";
  /**
   * The app's eve version, checked against each mounted extension's
   * `peerDependencies.eve`. Defaults to the running eve's version; injectable
   * for tests.
   */
  eveVersion?: string;
}

/**
 * Result of discovering one authored agent source graph.
 */
interface DiscoverAgentResult {
  diagnostics: DiscoverDiagnostic[];
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
  const eveVersion = input.eveVersion ?? resolveInstalledPackageInfo().version;
  const diagnostics: DiscoverDiagnostic[] = [];
  const packageName = await tryReadPackageJsonName(source, appRoot);
  const rootEntries = await readSortedDirectoryEntries(source, agentRoot);

  diagnostics.push(
    ...createUnsupportedRootDirectoryDiagnostics({
      classifyEntry: classifyAgentRootEntry,
      createUnsupportedDirectoryMessage(directoryName) {
        return `Ignoring unsupported directory "${directoryName}/" in the agent root.`;
      },
      rootEntries,
      rootPath: agentRoot,
    }),
  );

  const instructionsResult = await discoverInstructionsSource({
    rootEntries,
    rootPath: agentRoot,
    source,
    required: role !== "extension",
  });
  diagnostics.push(...instructionsResult.diagnostics);

  const configModuleResult = discoverFlatModuleSource({
    rootEntries,
    rootPath: agentRoot,
    slotName: "agent",
  });
  diagnostics.push(...configModuleResult.diagnostics);

  const channelsResult = await discoverNamedSourceDirectory({
    directoryName: "channels",
    invalidDirectoryCode: DISCOVER_CHANNELS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "channels")}" to be a directory of authored channels.`,
    recursive: true,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createChannelNameDiagnostic,
  });
  diagnostics.push(...channelsResult.diagnostics);

  const libResult = await discoverLibSources({
    agentRoot,
    rootEntries,
    source,
  });
  diagnostics.push(...libResult.diagnostics);

  const schedulesResult = await discoverScheduleSources({
    agentRoot,
    rootEntries,
    source,
  });
  diagnostics.push(...schedulesResult.diagnostics);

  const connectionsResult = await discoverConnectionSources({
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  diagnostics.push(...connectionsResult.diagnostics);

  const sandboxResult = await discoverSandboxSource({
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  diagnostics.push(...sandboxResult.diagnostics);

  if (role === "extension") {
    if (configModuleResult.module !== undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
          message:
            "An extension may not declare agent config (agent.ts) — model, limits, and sandbox are the consuming agent's to own.",
          sourcePath: join(agentRoot, configModuleResult.module.logicalPath),
        }),
      );
    }
    if (sandboxResult.sandbox !== null) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
          message: "An extension may not declare a sandbox — it is the consuming agent's to own.",
          sourcePath: join(agentRoot, sandboxResult.sandbox.logicalPath),
        }),
      );
    }
    const [firstSchedule] = schedulesResult.schedules;
    if (firstSchedule !== undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_SCHEDULE_UNSUPPORTED,
          message:
            "An extension may not declare schedules — background scheduling runs on the consuming agent's deployment under its limits, so it is the consuming agent's to own.",
          sourcePath: join(agentRoot, firstSchedule.logicalPath),
        }),
      );
    }
  }

  const toolsResult = await discoverNamedSourceDirectory({
    directoryName: "tools",
    invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(agentRoot, "tools")}" to be a directory of authored tools.`,
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
    recursive: false,
    rootEntries,
    rootPath: agentRoot,
    source,
    validateSegment: createExtensionNameDiagnostic,
  });
  diagnostics.push(...extensionsResult.diagnostics);

  const skillsResult = await discoverSkills({
    agentRoot,
    source,
  });
  diagnostics.push(...skillsResult.diagnostics);

  const subagentsResult = await discoverSubagents({
    agentRoot,
    appRoot,
    source,
  });
  diagnostics.push(...subagentsResult.diagnostics);

  const mountCollection = await collectExtensionMounts({
    agentRoot,
    fileMounts: extensionsResult.sources,
    rootEntries,
    source,
  });
  diagnostics.push(...mountCollection.diagnostics);

  // Overrides must be co-located in the mount directory. An agent-root
  // contribution using a mounted extension's `<ns>__` composed-name prefix would
  // shadow that extension from outside its mount directory, so reject it.
  diagnostics.push(
    ...detectRootNamespaceCollisions({
      agentRoot,
      namespaces: mountCollection.mounts.map((descriptor) => descriptor.namespace),
      sources: [
        ...toolsResult.sources,
        ...connectionsResult.connections,
        ...skillsResult.skills,
        ...schedulesResult.schedules,
      ],
    }),
  );

  const resolvedExtensions: ResolvedExtensionMount[] = [];
  if (role !== "agent") {
    // Extensions cannot mount other extensions yet. Fail loudly instead of
    // silently dropping the nested mount, and reserve the behavior so enabling
    // it later is additive.
    for (const descriptor of mountCollection.mounts) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
          message: `"${descriptor.mountRef.logicalPath}" mounts an extension from inside an extension, which is not supported yet. Extensions cannot mount other extensions; remove the "extensions/" slot.`,
          sourcePath: join(agentRoot, descriptor.mountRef.logicalPath),
        }),
      );
    }
  } else {
    for (const descriptor of mountCollection.mounts) {
      const located = await locateExtensionMount({
        source,
        agentRoot,
        appRoot,
        mount: descriptor.mountRef,
        namespace: descriptor.namespace,
        eveVersion,
      });
      diagnostics.push(...located.diagnostics);
      if (located.location === undefined) {
        continue;
      }

      const extensionResult = await discoverAgent({
        agentRoot: located.location.sourceRoot,
        appRoot: located.location.packageRoot,
        source,
        role: "extension",
      });
      diagnostics.push(...extensionResult.diagnostics);

      // The mount directory's override slots discover as an agent-shaped source;
      // its `extension.<ext>` declaration matches no slot, so it is ignored here.
      let overrides: AgentSourceManifest | undefined;
      if (descriptor.overridesRoot !== undefined) {
        const overridesResult = await discoverAgent({
          agentRoot: descriptor.overridesRoot,
          appRoot,
          source,
          role: "extension",
        });
        diagnostics.push(...overridesResult.diagnostics);
        overrides = overridesResult.manifest;
      }

      const resolved: { -readonly [K in keyof ResolvedExtensionMount]: ResolvedExtensionMount[K] } =
        {
          namespace: located.location.namespace,
          specifier: located.location.specifier,
          packageName: located.location.packageName,
          packageRoot: located.location.packageRoot,
          sourceRoot: located.location.sourceRoot,
          manifest: extensionResult.manifest,
        };
      if (overrides !== undefined) {
        resolved.overrides = overrides;
      }

      resolvedExtensions.push(resolved);
    }
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
interface ExtensionMountDescriptor {
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

/**
 * Flags agent-root contributions whose composed name uses a mounted extension's
 * `<ns>__` prefix. That prefix is reserved for the extension and its co-located
 * overrides, so a root-level `<ns>__…` file would override the extension from
 * outside its mount directory — rejected here.
 */
function detectRootNamespaceCollisions(input: {
  readonly agentRoot: string;
  readonly namespaces: readonly string[];
  readonly sources: ReadonlyArray<{ readonly logicalPath: string }>;
}): DiscoverDiagnostic[] {
  if (input.namespaces.length === 0) {
    return [];
  }

  const diagnostics: DiscoverDiagnostic[] = [];
  for (const source of input.sources) {
    const name = rootContributionName(source.logicalPath);
    const namespace = input.namespaces.find((candidate) => name.startsWith(`${candidate}__`));
    if (namespace !== undefined) {
      diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
          message: `"${source.logicalPath}" uses the "${namespace}__" prefix reserved for the mounted extension "${namespace}". Override an extension's contributions inside its mount directory ("extensions/${namespace}/…"), not at the agent root.`,
          sourcePath: join(input.agentRoot, source.logicalPath),
        }),
      );
    }
  }
  return diagnostics;
}

/**
 * Derives a contribution's composed name from its slot-relative logical path:
 * the first path segment below the slot directory, minus any module extension
 * (`tools/crm__x.ts` → `crm__x`; `skills/crm__x/SKILL.md` → `crm__x`).
 */
function rootContributionName(logicalPath: string): string {
  const afterSlot = logicalPath.slice(logicalPath.indexOf("/") + 1);
  const firstSegment = afterSlot.split("/")[0] ?? afterSlot;
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (firstSegment.toLowerCase().endsWith(extension)) {
      return firstSegment.slice(0, firstSegment.length - extension.length);
    }
  }
  return firstSegment;
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
