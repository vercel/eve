import {
  type AgentModuleBinding,
  type AgentSourceRegistry,
  loadProgrammaticModuleNamespace,
  memoizeModuleNamespaceFactories,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";
import {
  loadAuthoredModuleNamespace,
  type AuthoredModuleLoadOptions,
} from "#internal/authored-module-loader.js";
import type { AuthoredModuleGraph } from "#internal/authored-module-graph.js";

export type CompiledBindingNamespaceLoader = (
  sourceId: string,
) => Promise<ProgrammaticModuleNamespace>;

export interface ExtensionCompileMount {
  readonly mountId: string;
  readonly entry?: NonNullable<AuthoredModuleLoadOptions["extension"]>["entry"];
}

/** Loads one node's selected bindings with dependency ordering and per-phase caching. */
export function createCompiledBindingNamespaceLoader(input: {
  readonly bindings?: Readonly<Record<string, AgentModuleBinding>>;
  readonly graph?: AuthoredModuleGraph;
  readonly mounts?: ReadonlyMap<string, ExtensionCompileMount>;
  readonly evaluationId?: string;
  readonly mountSourceId?: (binding: AgentModuleBinding) => string | undefined;
  readonly onLoad?: (sourceId: string) => void;
  readonly registries: readonly AgentSourceRegistry[];
  readonly resolveBinding?: (sourceId: string) => AgentModuleBinding | undefined;
}): CompiledBindingNamespaceLoader {
  if (input.bindings === undefined && input.resolveBinding === undefined) {
    throw new Error("Compiled binding namespace loader requires a binding source.");
  }
  const cache = new Map<string, Promise<ProgrammaticModuleNamespace>>();

  const load = (
    sourceId: string,
    lineage: ReadonlySet<string> = new Set(),
  ): Promise<ProgrammaticModuleNamespace> => {
    if (lineage.has(sourceId)) {
      throw new Error(`Compiled binding dependency cycle includes "${sourceId}".`);
    }
    const cached = cache.get(sourceId);
    if (cached !== undefined) return cached;
    const binding = input.resolveBinding?.(sourceId) ?? input.bindings?.[sourceId];
    if (binding === undefined) {
      throw new Error(`Compiled binding dependency "${sourceId}" is missing.`);
    }
    input.onLoad?.(sourceId);
    const nextLineage = new Set(lineage).add(sourceId);
    const mountSourceId = input.mountSourceId?.(binding);
    const loading = (async () => {
      if (mountSourceId !== undefined && mountSourceId !== sourceId) {
        await load(mountSourceId, nextLineage);
      }
      return await loadCompiledBindingNamespace({
        binding,
        graph: input.graph,
        loadDependency: (dependencySourceId) => load(dependencySourceId, nextLineage),
        registries: input.registries,
        mounts: input.mounts,
        evaluationId: input.evaluationId,
      });
    })().then(memoizeModuleNamespaceFactories);
    cache.set(sourceId, loading);
    return loading;
  };

  return load;
}

async function loadCompiledBindingNamespace(input: {
  readonly binding: AgentModuleBinding;
  readonly graph?: AuthoredModuleGraph;
  readonly loadDependency: CompiledBindingNamespaceLoader;
  readonly mounts?: ReadonlyMap<string, ExtensionCompileMount>;
  readonly evaluationId?: string;
  readonly registries: readonly AgentSourceRegistry[];
}): Promise<ProgrammaticModuleNamespace> {
  if (input.binding.backing.kind === "filesystem") {
    const mountId =
      input.binding.owner.kind === "extension" ? input.binding.owner.mountId : undefined;
    const mount = mountId === undefined ? undefined : input.mounts?.get(mountId);
    if (mountId !== undefined && input.mounts !== undefined && mount === undefined) {
      throw new Error(`Missing mount "${mountId}" for extension contribution.`);
    }
    const extension: AuthoredModuleLoadOptions["extension"] =
      mountId === undefined
        ? undefined
        : {
            mountId,
            evaluationId: input.evaluationId,
            entry: mount?.entry,
          };
    return await loadAuthoredModuleNamespace(input.binding.backing.sourcePath, {
      externalDependencies: input.binding.backing.externalDependencies,
      extension,
      graph: input.graph,
    });
  }
  const dependencyNamespaces = Object.fromEntries(
    await Promise.all(
      Object.entries(input.binding.backing.dependencies ?? {}).map(
        async ([alias, sourceId]) => [alias, await input.loadDependency(sourceId)] as const,
      ),
    ),
  );
  return await loadProgrammaticModuleNamespace({
    backing: input.binding.backing,
    dependencyNamespaces,
    registries: input.registries,
  });
}

/** Derives the owning mount for state handles in an extension module. */
export function resolveExtensionBindingMountId(binding: AgentModuleBinding): string | undefined {
  return binding.owner.kind === "extension" ? binding.owner.mountId : undefined;
}
