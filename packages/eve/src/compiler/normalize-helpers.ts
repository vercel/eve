import { resolve } from "node:path";

import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import type { AuthoredModuleLoadOptions } from "#internal/authored-module-loader.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import {
  createAgentModuleNamespaceLoader,
  type AgentModuleNamespaceLoader,
} from "#compiler/module-namespace-loader.js";

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
  readonly bindingsByAgentRoot: Map<string, Readonly<Record<string, CompiledModuleBinding>>>;
  readonly modelCatalog: CompiledRuntimeModelCatalogLoader;
  readonly moduleLoader: AgentModuleNamespaceLoader;
}

export interface ModuleBackedDefinitionLoadOptions {
  readonly binding?: CompiledModuleBinding;
  readonly externalDependencies?: AuthoredModuleLoadOptions["externalDependencies"];
  readonly moduleLoader?: AgentModuleNamespaceLoader;
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
  readonly agentRoot: string;
  readonly displayPath?: string;
  readonly binding?: CompiledModuleBinding;
  readonly externalDependencies?: ModuleBackedDefinitionLoadOptions["externalDependencies"];
  readonly kind: string;
  readonly moduleLoader?: AgentModuleNamespaceLoader;
  readonly source: ModuleSourceRef;
}): Promise<unknown> {
  const binding =
    input.binding ??
    ({
      backing: {
        externalDependencies: [...(input.externalDependencies ?? [])],
        kind: "filesystem",
        sourcePath: resolve(input.agentRoot, input.source.logicalPath),
      },
      logicalPath: input.source.logicalPath,
      owner: { kind: "application" },
    } satisfies CompiledModuleBinding);
  const moduleNamespace = await (input.moduleLoader ?? createAgentModuleNamespaceLoader()).load(
    binding.backing,
  );
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
