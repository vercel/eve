import { join } from "node:path";

import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import {
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
  locateExtensionMount,
} from "#discover/extensions.js";
import {
  discoverExtensionMountDeclarationsFromEntries,
  type ExtensionMountDescriptor,
} from "#discover/extension-mount-declarations.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import type {
  AgentSourceManifest,
  ExtensionSourceRef,
  ResolvedExtensionMount,
} from "#discover/manifest.js";
import type { ProjectSource, ProjectSourceEntry } from "#discover/project-source.js";

/** Discovers an extension-owned agent-shaped source tree. */
export type DiscoverExtensionSourceTree = (input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly source: ProjectSource;
}) => Promise<{
  readonly diagnostics: DiscoverDiagnostic[];
  readonly manifest: AgentSourceManifest;
}>;

/** Discovers and resolves the mounted extensions owned by one agent graph node. */
export async function discoverMountedExtensions(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly contributionSources: ReadonlyArray<{ readonly logicalPath: string }>;
  readonly discoverExtensionSourceTree: DiscoverExtensionSourceTree;
  readonly resolveMounts: boolean;
  readonly rootEntries: readonly ProjectSourceEntry[];
  readonly source: ProjectSource;
}): Promise<{
  readonly diagnostics: DiscoverDiagnostic[];
  readonly extensions: ExtensionSourceRef[];
  readonly resolvedExtensions: ResolvedExtensionMount[];
}> {
  const declarations = await discoverExtensionMountDeclarationsFromEntries({
    agentRoot: input.agentRoot,
    rootEntries: input.rootEntries,
    source: input.source,
  });
  const diagnostics = [...declarations.diagnostics];
  const extensions = declarations.mounts.map((descriptor) => descriptor.mountRef);

  diagnostics.push(
    ...detectRootNamespaceCollisions({
      agentRoot: input.agentRoot,
      namespaces: declarations.mounts.map((descriptor) => descriptor.namespace),
      sources: input.contributionSources,
    }),
  );

  if (!input.resolveMounts) {
    diagnostics.push(...createNestedMountDiagnostics(input.agentRoot, declarations.mounts));
    return { diagnostics, extensions, resolvedExtensions: [] };
  }

  const resolvedExtensions: ResolvedExtensionMount[] = [];
  for (const descriptor of declarations.mounts) {
    const located = await locateExtensionMount({
      source: input.source,
      agentRoot: input.agentRoot,
      appRoot: input.appRoot,
      mount: descriptor.mountRef,
      namespace: descriptor.namespace,
    });
    diagnostics.push(...located.diagnostics);
    if (located.location === undefined) {
      continue;
    }

    const extensionResult = await input.discoverExtensionSourceTree({
      agentRoot: located.location.sourceRoot,
      appRoot: located.location.packageRoot,
      source: input.source,
    });
    diagnostics.push(...extensionResult.diagnostics);

    let overrides: AgentSourceManifest | undefined;
    if (descriptor.overridesRoot !== undefined) {
      const overridesResult = await input.discoverExtensionSourceTree({
        agentRoot: descriptor.overridesRoot,
        appRoot: input.appRoot,
        source: input.source,
      });
      diagnostics.push(...overridesResult.diagnostics);
      overrides = overridesResult.manifest;
    }

    const resolved: { -readonly [K in keyof ResolvedExtensionMount]: ResolvedExtensionMount[K] } = {
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

  return { diagnostics, extensions, resolvedExtensions };
}

function createNestedMountDiagnostics(
  agentRoot: string,
  mounts: readonly ExtensionMountDescriptor[],
): DiscoverDiagnostic[] {
  return mounts.map((descriptor) =>
    createDiscoverErrorDiagnostic({
      code: DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
      message: `"${descriptor.mountRef.logicalPath}" mounts an extension from inside an extension, which is not supported yet. Extensions cannot mount other extensions; remove the "extensions/" slot.`,
      sourcePath: join(agentRoot, descriptor.mountRef.logicalPath),
    }),
  );
}

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
