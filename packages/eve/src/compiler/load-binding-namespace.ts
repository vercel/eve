import {
  type AgentModuleBinding,
  type AgentSourceRegistry,
  loadProgrammaticModuleNamespace,
  memoizeModuleNamespaceFactories,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";
import { packageStateNamespace } from "#discover/extensions.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";

export type CompiledBindingNamespaceLoader = (
  sourceId: string,
) => Promise<ProgrammaticModuleNamespace>;

/** Loads one node's selected bindings with dependency ordering and per-phase caching. */
export function createCompiledBindingNamespaceLoader(input: {
  readonly bindings?: Readonly<Record<string, AgentModuleBinding>>;
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
    const loading = loadCompiledBindingNamespace({
      binding,
      loadDependency: (dependencySourceId) => load(dependencySourceId, nextLineage),
      registries: input.registries,
    }).then(memoizeModuleNamespaceFactories);
    cache.set(sourceId, loading);
    return loading;
  };

  return load;
}

async function loadCompiledBindingNamespace(input: {
  readonly binding: AgentModuleBinding;
  readonly loadDependency: CompiledBindingNamespaceLoader;
  readonly registries: readonly AgentSourceRegistry[];
}): Promise<ProgrammaticModuleNamespace> {
  if (input.binding.backing.kind === "filesystem") {
    return await loadAuthoredModuleNamespace(input.binding.backing.sourcePath, {
      externalDependencies: input.binding.backing.externalDependencies,
      extensionScopeNamespace: resolveCompiledModuleExtensionScopeNamespace(input.binding),
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

/** Derives the stable package-owned scope used while loading an extension module. */
export function resolveCompiledModuleExtensionScopeNamespace(
  binding: AgentModuleBinding,
): string | undefined {
  return binding.owner.kind === "extension"
    ? packageStateNamespace(binding.owner.packageName)
    : undefined;
}
