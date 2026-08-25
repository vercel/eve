import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import {
  type AuthoredModuleLoadOptions,
  loadAuthoredModuleNamespace,
} from "#internal/authored-module-loader.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  loadProgrammaticModuleNamespace,
  type AgentModuleBacking,
  type AgentSourceRegistry,
} from "#compiler/source-graph.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";

const SANDBOX_PARENT_DEFINITION_MARKER = Symbol.for("eve.sandbox-parent-definition");

/**
 * Loads one discovered module export directly from an authored tree.
 *
 * For pre-composition inspection paths (setup conflict checks, extension
 * capability derivation) that examine a discovery manifest without
 * compiling it. Artifact compilation always loads through
 * {@link loadComposedModuleDefinition} instead.
 */
export async function loadDiscoveredModuleExport(input: {
  readonly agentRoot: string;
  readonly externalDependencies?: readonly string[];
  readonly source: { readonly exportName?: string; readonly logicalPath: string };
}): Promise<unknown> {
  const moduleNamespace = await loadAuthoredModuleNamespace(
    `${input.agentRoot}/${input.source.logicalPath}`,
    { externalDependencies: input.externalDependencies },
  );
  const exportValue = getAuthoredModuleExport(moduleNamespace, input.source);
  return await materializeAuthoredModuleExport(exportValue);
}

/**
 * Shared compile-time context threaded through every per-primitive
 * normalize step.
 *
 * Holds expensive lazily-loaded resources (currently the model catalog),
 * the assembled programmatic source registry, and the compiler diagnostic
 * accumulator that stays open until route planning completes.
 */
export interface ManifestCompileContext {
  /** Programmatic application sources (in-memory compilation only). */
  readonly applicationRegistry?: AgentSourceRegistry;
  /** The closed framework source registrations. */
  readonly frameworkRegistry: AgentSourceRegistry;
  readonly modelCatalog: CompiledRuntimeModelCatalogLoader;
  /** Combined registry used to load selected programmatic bindings. */
  readonly registry: AgentSourceRegistry;
}

export interface ModuleBackedDefinitionLoadOptions {
  readonly externalDependencies?: AuthoredModuleLoadOptions["externalDependencies"];
}

/**
 * Loads one selected candidate's export through its explicit physical
 * backing and resolves any value-returning factory it may export.
 *
 * Filesystem backings load from their explicit `sourcePath` with the
 * candidate's extension scope; programmatic backings resolve through the
 * assembled registry, rejecting a missing module or mismatched revision
 * before evaluating any namespace loader. `logicalPath` is never joined to
 * an agent root here.
 */
export async function loadComposedModuleDefinition(input: {
  readonly backing: AgentModuleBacking | undefined;
  readonly displayPath?: string;
  readonly exportName?: string;
  readonly extensionScopePackageNamespace?: string;
  readonly externalDependencies?: ModuleBackedDefinitionLoadOptions["externalDependencies"];
  readonly kind: string;
  readonly logicalPath: string;
  readonly registry: AgentSourceRegistry;
}): Promise<unknown> {
  const backing = input.backing;
  if (backing === undefined) {
    throw new Error(
      `Cannot load "${input.logicalPath}" as a module: the selected source has no module backing.`,
    );
  }

  const moduleNamespace =
    backing.kind === "programmatic"
      ? await loadProgrammaticModuleNamespace(input.registry, backing)
      : await loadAuthoredModuleNamespace(backing.sourcePath, {
          externalDependencies: input.externalDependencies,
          extensionScopeNamespace: input.extensionScopePackageNamespace,
        });
  const exportValue = getAuthoredModuleExport(moduleNamespace, {
    exportName: input.exportName,
    logicalPath: input.logicalPath,
  });

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
        `Failed to execute the sandbox export "${input.exportName ?? "default"}" from "${input.displayPath ?? input.logicalPath}" as a zero-argument definition factory. Parent-sharing callbacks must be passed to defineSandbox(...): ${toErrorMessage(error)}`,
      );
    }
    throw new Error(
      `Failed to execute the ${input.kind} export "${input.exportName ?? "default"}" from "${input.displayPath ?? input.logicalPath}": ${toErrorMessage(error)}`,
    );
  }
}
