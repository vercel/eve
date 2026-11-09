import { z } from "#compiled/zod/index.js";
import type { CompiledAgentNodeManifest, CompiledAgentResources } from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";

// The compiled module map's shape, and which bindings a compiled node runs, apart from generating
// and loading the map (`module-map.ts`), which needs the authored-module loader. A runtime that
// only reads a map, such as a browser's, stops here.

export type CompiledModuleMap = z.infer<typeof compiledModuleMapSchema>;

const compiledModuleNodeScopeSchema = z
  .object({ modules: z.record(z.string(), z.object({}).passthrough()) })
  .strict();

export const compiledModuleMapSchema = z
  .object({ nodes: z.record(z.string(), compiledModuleNodeScopeSchema) })
  .strict();

/** A compiled module and the source id it's bound under. */
export interface BoundModule {
  readonly binding: CompiledModuleBinding;
  readonly sourceId: string;
}

/** Returns one compiled node's finalized runtime entries, including remote config modules. */
export function collectRuntimeModuleBindingsForManifest(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): readonly BoundModule[] {
  const modules = new Map<string, CompiledModuleBinding>(
    Object.entries(manifest.bindings).filter(([, binding]) => binding.usage.runtimeEntry),
  );
  for (const remote of manifest.remoteAgents) {
    if (!remote.binding.usage.runtimeEntry) continue;
    if (modules.has(remote.sourceId)) {
      throw new Error(`Remote agent binding "${remote.sourceId}" collides with a node binding.`);
    }
    modules.set(remote.sourceId, remote.binding);
  }
  return orderBoundModules(
    [...modules]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, binding]) => ({ binding, sourceId })),
  );
}

/** `modules` with each one after the module its extension mounts from, when that is one of them. */
export function orderBoundModules(
  modules: readonly BoundModule[],
  mountSourceId?: (binding: CompiledModuleBinding) => string | undefined,
): readonly BoundModule[] {
  const bySourceId = new Map(modules.map((module) => [module.sourceId, module]));
  const ordered: BoundModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (module: BoundModule): void => {
    if (visited.has(module.sourceId)) return;
    if (visiting.has(module.sourceId)) {
      throw new Error(`Compiled module dependency cycle includes "${module.sourceId}".`);
    }
    visiting.add(module.sourceId);
    const mount = mountSourceId?.(module.binding);
    if (mount !== undefined && mount !== module.sourceId) {
      const dependency = bySourceId.get(mount);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(module.sourceId);
    visited.add(module.sourceId);
    ordered.push(module);
  };
  for (const module of modules) visit(module);
  return ordered;
}
