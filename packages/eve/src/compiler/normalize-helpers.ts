import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import {
  type AgentSourceRegistry,
  type CompiledModuleBinding,
  type AgentSourceOwner,
} from "#compiler/source-graph.js";
import type { CompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";

const SANDBOX_PARENT_DEFINITION_MARKER = Symbol.for("eve.sandbox-parent-definition");

/**
 * Shared compile-time context threaded through every per-primitive
 * normalize step.
 *
 * Holds expensive lazily-loaded resources (currently the model catalog)
 * so each `compileAgentManifest` invocation pays the load cost once and
 * reuses the cache across all of its child compilations.
 */
export interface ManifestCompileContext {
  readonly modelCatalog: CompiledRuntimeModelCatalogLoader;
  readonly registries: readonly AgentSourceRegistry[];
}

export interface ModuleBackedDefinitionLoadOptions {
  readonly binding: CompiledModuleBinding;
  readonly loadNamespace: CompiledBindingNamespaceLoader;
}

export interface SourceDefinitionCompileOptions {
  readonly binding?: CompiledModuleBinding;
  readonly loadNamespace?: CompiledBindingNamespaceLoader;
  readonly owner: AgentSourceOwner;
}

export function requireModuleBackedDefinitionLoadOptions(
  options: SourceDefinitionCompileOptions,
  logicalPath: string,
): ModuleBackedDefinitionLoadOptions {
  if (options.binding === undefined || options.loadNamespace === undefined) {
    throw new Error(`Module-backed source "${logicalPath}" requires a compiled binding.`);
  }
  return { binding: options.binding, loadNamespace: options.loadNamespace };
}

/**
 * Loads one authored module's value for a given source reference and
 * resolves any value-returning factory it may export.
 *
 * Used by every per-primitive compiler that targets a `module` source
 * (channels, sandboxes, tools, schedules, skills, prompt layers,
 * subagents). Wraps execution errors so the message identifies which
 * authored file failed.
 */
export async function loadModuleBackedDefinition(input: {
  readonly binding: CompiledModuleBinding;
  readonly displayPath?: string;
  readonly kind: string;
  readonly loadNamespace: CompiledBindingNamespaceLoader;
  readonly source: ModuleSourceRef;
}): Promise<unknown> {
  if (input.binding.logicalPath !== input.source.logicalPath) {
    throw new Error(
      `Compiled binding "${input.source.sourceId}" targets "${input.binding.logicalPath}", not "${input.source.logicalPath}".`,
    );
  }
  const moduleNamespace = await input.loadNamespace(input.source.sourceId);
  const exportValue = getAuthoredModuleExport(moduleNamespace, input.source);

  // defineSandbox marks parent selectors so they remain distinguishable from
  // zero-argument module factories without relying on JavaScript function arity.
  if (
    input.kind === "sandbox" &&
    typeof exportValue === "function" &&
    Reflect.get(exportValue, SANDBOX_PARENT_DEFINITION_MARKER) === true
  ) {
    return exportValue;
  }

  try {
    return await materializeAuthoredModuleExport(exportValue);
  } catch (error) {
    if (input.kind === "sandbox" && typeof exportValue === "function") {
      throw new Error(
        `Failed to execute the sandbox export "${input.source.exportName ?? "default"}" from "${input.displayPath ?? input.source.logicalPath}" as a zero-argument definition factory. Parent-sharing callbacks must be passed to defineSandbox(...): ${toErrorMessage(error)}`,
      );
    }
    throw new Error(
      `Failed to execute the ${input.kind} export "${input.source.exportName ?? "default"}" from "${input.displayPath ?? input.source.logicalPath}": ${toErrorMessage(error)}`,
    );
  }
}
