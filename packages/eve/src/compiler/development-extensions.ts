import { projectDiscoverDiagnostic, type CompilerDiagnostic } from "#compiler/diagnostics.js";
import {
  createBundledExtensionMount,
  type BundledExtensionDescriptor,
  type BundledExtensionMount,
} from "#compiler/bundled-extension.js";
import {
  createAgentSourceRegistry,
  createProgrammaticModuleCandidates,
  type AgentModuleCandidate,
  type AgentSourceRegistry,
  type ProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { discoverBundledExtension } from "#discover/bundled-extension.js";
import { mountRefNamespace } from "#discover/extensions.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";

// Keep this indirect so extension-contract declaration generation does not follow the dev-only mount.
const SELF_MODIFICATION_EXTENSION_MODULE = "#self-modification/extension/extension.js";

const DEVELOPMENT_EXTENSION_IDS = ["self-modification"] as const;

export type DevelopmentExtensionId = (typeof DEVELOPMENT_EXTENSION_IDS)[number];

export interface DevelopmentExtensionSelection {
  readonly enabled: readonly DevelopmentExtensionId[];
}

// Hosted bundles can retain compiler modules, so package-owned paths must stay unresolved
// until a development extension is actually selected.
let bundledExtensionById: ReadonlyMap<string, BundledExtensionMount> | undefined;
let developmentSourceRegistry: AgentSourceRegistry | undefined;

function getBundledExtensionById(): ReadonlyMap<string, BundledExtensionMount> {
  if (bundledExtensionById === undefined) {
    bundledExtensionById = new Map(
      (
        [
          {
            namespace: "self-modification",
            sourceDirectory: resolvePackageSourceDirectoryPath("src/self-modification/extension"),
            loadMount: async () => {
              const { default: extension } = await import(SELF_MODIFICATION_EXTENSION_MODULE);
              return extension({ local: { enabled: true } });
            },
          },
        ] as const satisfies readonly BundledExtensionDescriptor[]
      )
        .map(createBundledExtensionMount)
        .map((extension) => [extension.namespace, extension]),
    );
  }
  return bundledExtensionById;
}

/** Returns the registry used only by generated local-development module maps. */
export function getDevelopmentExtensionSourceRegistry(): AgentSourceRegistry {
  developmentSourceRegistry ??= createAgentSourceRegistry([], {
    extensionDeclarations: [...getBundledExtensionById().values()].map(
      (extension): ProgrammaticAgentSource => extension.declaration,
    ),
  });
  return developmentSourceRegistry;
}

const DEFAULT_DEVELOPMENT_EXTENSION_IDS: readonly DevelopmentExtensionId[] =
  DEVELOPMENT_EXTENSION_IDS;
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
  const extensionsById =
    input.selection.enabled.length === 0 ? undefined : getBundledExtensionById();

  for (const id of new Set(input.selection.enabled)) {
    const extension = extensionsById?.get(id);
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
