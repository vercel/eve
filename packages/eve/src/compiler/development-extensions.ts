import { projectDiscoverDiagnostic, type CompilerDiagnostic } from "#compiler/diagnostics.js";
import {
  createBundledExtensionMount,
  type BundledExtensionDescriptor,
  type BundledExtensionMount,
} from "#compiler/bundled-extension.js";
import {
  createProgrammaticModuleCandidates,
  type AgentModuleCandidate,
  type ProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { discoverBundledExtension } from "#discover/bundled-extension.js";
import { mountRefNamespace } from "#discover/extensions.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";

const BUNDLED_EXTENSION_DESCRIPTORS = [
  {
    namespace: "self-modification",
    sourceDirectory: resolvePackageSourceDirectoryPath("src/self-modification/extension"),
    loadMount: async () => {
      const { default: extension } = await import("#self-modification/extension/extension.js");
      return extension({ local: { enabled: true } });
    },
  },
] as const satisfies readonly BundledExtensionDescriptor[];

export type DevelopmentExtensionId = (typeof BUNDLED_EXTENSION_DESCRIPTORS)[number]["namespace"];

export interface DevelopmentExtensionSelection {
  readonly enabled: readonly DevelopmentExtensionId[];
}

const BUNDLED_EXTENSION_MOUNTS: readonly BundledExtensionMount[] =
  BUNDLED_EXTENSION_DESCRIPTORS.map(createBundledExtensionMount);
const BUNDLED_EXTENSION_BY_ID = new Map(
  BUNDLED_EXTENSION_MOUNTS.map((extension) => [extension.namespace, extension]),
);

/** Declarations available to the runtime programmatic-module registry. */
export const developmentExtensionDeclarations: readonly ProgrammaticAgentSource[] =
  BUNDLED_EXTENSION_MOUNTS.map((extension) => extension.declaration);

const DEFAULT_DEVELOPMENT_EXTENSION_IDS: readonly DevelopmentExtensionId[] = ["self-modification"];
const NO_DEVELOPMENT_EXTENSION_IDS: readonly DevelopmentExtensionId[] = [];

export function defaultDevelopmentExtensions(): DevelopmentExtensionSelection {
  return { enabled: DEFAULT_DEVELOPMENT_EXTENSION_IDS };
}

export function noDevelopmentExtensions(): DevelopmentExtensionSelection {
  return { enabled: NO_DEVELOPMENT_EXTENSION_IDS };
}

/** Discovers selected bundled extensions and creates their root mount candidates. */
export async function prepareDevelopmentExtensions(input: {
  readonly diagnostics: CompilerDiagnostic[];
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly selection: DevelopmentExtensionSelection;
}): Promise<{
  readonly candidates: readonly AgentModuleCandidate[];
  readonly manifest: AgentSourceManifest;
}> {
  const existingNamespaces = new Set([
    ...input.manifest.extensions.map((extension) => mountRefNamespace(extension.logicalPath)),
    ...input.manifest.resolvedExtensions.map((extension) => extension.namespace),
  ]);
  const selected = new Map<string, BundledExtensionMount>();

  for (const id of new Set(input.selection.enabled)) {
    const extension = BUNDLED_EXTENSION_BY_ID.get(id);
    if (extension === undefined) throw new Error(`Unknown development extension "${id}".`);
    const existing = selected.get(extension.namespace);
    if (existing !== undefined && existing !== extension) {
      throw new Error(
        `Development extensions use namespace "${extension.namespace}" more than once.`,
      );
    }
    if (existingNamespaces.has(extension.namespace)) continue;
    existingNamespaces.add(extension.namespace);
    selected.set(extension.namespace, extension);
  }

  const resolvedExtensions = [...input.manifest.resolvedExtensions];
  const candidates: AgentModuleCandidate[] = [];
  for (const extension of selected.values()) {
    const discovered = await discoverBundledExtension({ mount: extension });
    input.diagnostics.push(
      ...discovered.diagnostics.map((diagnostic) =>
        projectDiscoverDiagnostic(diagnostic, input.nodeId),
      ),
    );
    resolvedExtensions.push(discovered.mount);
    candidates.push(
      ...createProgrammaticModuleCandidates({
        layer: "framework-default",
        nodeId: input.nodeId,
        owner: { feature: extension.declaration.id, kind: "framework" },
        registration: { applyTo: "root", source: extension.declaration },
      }),
    );
  }

  return {
    candidates,
    manifest: {
      ...input.manifest,
      resolvedExtensions,
    },
  };
}
