import type {
  AgentModuleBinding,
  AgentSourceRegistry,
  CompiledModuleBinding,
} from "#compiler/source-graph.js";
import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import {
  createCompiledBindingNamespaceLoader,
  type CompiledBindingNamespaceLoader,
} from "#compiler/load-binding-namespace.js";

/** Owns namespace loading and lifecycle decisions for one node compilation. */
export class NodeModuleEvaluationContext {
  #bindings: Readonly<Record<string, AgentModuleBinding>> = {};
  readonly #lifecycle = new NodeModuleLifecycle();
  readonly loadNamespace: CompiledBindingNamespaceLoader;

  constructor(registries: readonly AgentSourceRegistry[]) {
    this.loadNamespace = createCompiledBindingNamespaceLoader({
      onLoad: (sourceId) => this.#lifecycle.recordCompileLoad(sourceId),
      registries,
      resolveBinding: (sourceId) => this.#bindings[sourceId],
    });
  }

  setBindings(bindings: Readonly<Record<string, AgentModuleBinding>>): void {
    this.#bindings = bindings;
  }

  requireRuntimeEntry(sourceId: string): void {
    this.#lifecycle.requireRuntimeEntry(sourceId);
  }

  finalizeBindings(): Record<string, CompiledModuleBinding> {
    return this.#lifecycle.finalize(this.#bindings);
  }
}

/** Marks authored config namespaces whose values must be resolved by the runtime. */
export function markConfigRuntimeEntries(
  config: CompiledAgentDefinition,
  evaluation: NodeModuleEvaluationContext,
): void {
  const sources = [config.dynamicModel, config.model?.source, config.compaction?.model?.source];
  for (const source of sources) {
    if (source !== undefined) evaluation.requireRuntimeEntry(source.sourceId);
  }
}

/** Tracks one selected node's module namespace usage across compilation and runtime linking. */
class NodeModuleLifecycle {
  readonly #compileLoads = new Set<string>();
  readonly #runtimeRoots = new Set<string>();

  recordCompileLoad(sourceId: string): void {
    this.#compileLoads.add(sourceId);
  }

  requireRuntimeEntry(sourceId: string): void {
    this.#runtimeRoots.add(sourceId);
  }

  finalize(
    bindings: Readonly<Record<string, AgentModuleBinding>>,
  ): Record<string, CompiledModuleBinding> {
    const runtimeEntries = collectRuntimeEntryClosure(bindings, this.#runtimeRoots);
    const compiled: Record<string, CompiledModuleBinding> = {};

    for (const [sourceId, binding] of Object.entries(bindings)) {
      const usage = {
        compile: this.#compileLoads.has(sourceId),
        runtimeEntry: runtimeEntries.has(sourceId),
      };
      if (!usage.compile && !usage.runtimeEntry) {
        throw new Error(`Selected module binding "${sourceId}" has no compile or runtime usage.`);
      }
      compiled[sourceId] = Object.freeze({ ...binding, usage: Object.freeze(usage) });
    }

    return compiled;
  }
}

function collectRuntimeEntryClosure(
  bindings: Readonly<Record<string, AgentModuleBinding>>,
  roots: ReadonlySet<string>,
): Set<string> {
  const runtimeEntries = new Set<string>();
  const visiting = new Set<string>();

  const visit = (sourceId: string): void => {
    if (runtimeEntries.has(sourceId)) return;
    if (visiting.has(sourceId)) {
      throw new Error(`Compiled module dependency cycle includes "${sourceId}".`);
    }
    const binding = bindings[sourceId];
    if (binding === undefined) {
      throw new Error(`Runtime module entry "${sourceId}" has no selected binding.`);
    }
    visiting.add(sourceId);
    if (binding.backing.kind === "programmatic") {
      for (const dependencySourceId of Object.values(binding.backing.dependencies ?? {})) {
        visit(dependencySourceId);
      }
    }
    visiting.delete(sourceId);
    runtimeEntries.add(sourceId);
  };

  for (const sourceId of roots) visit(sourceId);
  return runtimeEntries;
}
