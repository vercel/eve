import { join, resolve } from "node:path";

import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  mountNamespace,
} from "#discover/extensions.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import {
  createExtensionNameDiagnostic,
  DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
  discoverFlatModuleSource,
  discoverNamedSourceDirectory,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { createModuleSourceRef, type ExtensionSourceRef } from "#discover/manifest.js";
import {
  createDiskProjectSource,
  type ProjectSource,
  type ProjectSourceEntry,
} from "#discover/project-source.js";

/** One extension mount declaration and its optional co-located override root. */
export interface ExtensionMountDescriptor {
  /** Mount namespace prefixed onto every composed contribution. */
  readonly namespace: string;
  /** Module ref for the mount declaration the package specifier is read from. */
  readonly mountRef: ExtensionSourceRef;
  /** Absolute path to the directory-form mount when it carries overrides. */
  readonly overridesRoot?: string;
}

/** One recursively discovered mount paired with the agent root that owns it. */
export interface AgentExtensionMountDescriptor {
  readonly agentRoot: string;
  readonly mount: ExtensionMountDescriptor;
}

/**
 * Discovers extension mount declarations without resolving their package
 * distributions. Development uses this before building local mounts.
 */
export async function discoverExtensionMountDeclarations(input: {
  readonly agentRoot: string;
  readonly source?: ProjectSource;
}): Promise<{
  readonly diagnostics: DiscoverDiagnostic[];
  readonly mounts: ExtensionMountDescriptor[];
}> {
  const source = input.source ?? createDiskProjectSource();
  const agentRoot = resolve(input.agentRoot);
  return await discoverExtensionMountDeclarationsFromEntries({
    agentRoot,
    rootEntries: await readSortedDirectoryEntries(source, agentRoot),
    source,
  });
}

/**
 * Discovers mount declarations from the root agent and every directory-form
 * local subagent without requiring extension distributions to exist yet.
 */
export async function discoverExtensionMountDeclarationsRecursively(input: {
  readonly agentRoot: string;
  readonly source?: ProjectSource;
}): Promise<{
  readonly diagnostics: DiscoverDiagnostic[];
  readonly mounts: AgentExtensionMountDescriptor[];
}> {
  const source = input.source ?? createDiskProjectSource();
  const diagnostics: DiscoverDiagnostic[] = [];
  const mounts: AgentExtensionMountDescriptor[] = [];

  async function visit(agentRoot: string): Promise<void> {
    const declarations = await discoverExtensionMountDeclarations({ agentRoot, source });
    diagnostics.push(...declarations.diagnostics);
    mounts.push(
      ...declarations.mounts.map((mount) => ({
        agentRoot,
        mount,
      })),
    );

    const subagentsRoot = join(agentRoot, "subagents");
    if ((await source.stat(subagentsRoot)) !== "directory") {
      return;
    }
    const entries = await readSortedDirectoryEntries(source, subagentsRoot);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(subagentsRoot, entry.name));
      }
    }
  }

  await visit(resolve(input.agentRoot));
  return { diagnostics, mounts };
}

/** Discovers mount declarations using an agent root listing already in memory. */
export async function discoverExtensionMountDeclarationsFromEntries(input: {
  readonly agentRoot: string;
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly source: ProjectSource;
}): Promise<{
  readonly diagnostics: DiscoverDiagnostic[];
  readonly mounts: ExtensionMountDescriptor[];
}> {
  const extensionsResult = await discoverNamedSourceDirectory({
    directoryName: "extensions",
    invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(input.agentRoot, "extensions")}" to be a directory of extension mounts.`,
    recursive: false,
    rootEntries: input.rootEntries,
    rootPath: input.agentRoot,
    source: input.source,
    validateSegment: createExtensionNameDiagnostic,
  });
  const collection = await collectExtensionMounts({
    agentRoot: input.agentRoot,
    fileMounts: extensionsResult.sources,
    rootEntries: input.rootEntries,
    source: input.source,
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
  readonly diagnostics: DiscoverDiagnostic[];
  readonly mounts: ExtensionMountDescriptor[];
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

  return {
    diagnostics,
    mounts: [...fileDescriptors, ...directoryDescriptors].filter(
      (descriptor) => !ambiguousNamespaces.has(descriptor.namespace),
    ),
  };
}
