import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import type { CompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import {
  createAgentModuleNamespaceLoader,
  type AgentModuleNamespaceLoader,
} from "#compiler/module-namespace-loader.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";

const SANDBOX_PARENT_DEFINITION_MARKER = Symbol.for("eve.sandbox-parent-definition");

/** Stable diagnostic code for a selected source that fails normalization. */
export const SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE = "compile/source-normalization-failed";

/** Error carrying the source-specific compiler diagnostic for a failed normalizer. */
export class SourceNormalizationError extends Error {
  readonly diagnostic: CompilerDiagnostic;

  constructor(
    source: {
      readonly kind: string;
      readonly logicalPath: string;
      readonly nodeId: string;
      readonly sourceId: string;
      readonly sourcePath?: string;
    },
    cause: unknown,
  ) {
    const diagnosticBase = {
      code: SOURCE_NORMALIZATION_FAILED_DIAGNOSTIC_CODE,
      logicalPath: source.logicalPath,
      message: `Failed to normalize selected ${source.kind} source "${source.logicalPath}": ${toErrorMessage(cause)}`,
      nodeId: source.nodeId,
      severity: "error",
      sourceId: source.sourceId,
    } as const;
    const diagnostic: CompilerDiagnostic =
      source.sourcePath === undefined
        ? diagnosticBase
        : { ...diagnosticBase, sourcePath: source.sourcePath };
    super(`[${diagnostic.code}] ${diagnostic.message}`);
    this.name = "SourceNormalizationError";
    this.diagnostic = diagnostic;
  }
}

/** Runs one selected-source normalizer and attaches canonical source provenance on failure. */
export async function normalizeSelectedSource<T>(
  source: {
    readonly kind: string;
    readonly logicalPath: string;
    readonly nodeId: string;
    readonly sourceId: string;
    readonly sourcePath?: string;
  },
  normalize: () => Promise<T> | T,
): Promise<T> {
  try {
    return await normalize();
  } catch (error) {
    if (error instanceof SourceNormalizationError) throw error;
    throw new SourceNormalizationError(source, error);
  }
}

/**
 * Shared compile-time context threaded through every per-primitive
 * normalize step.
 *
 * Holds expensive lazily-loaded resources (currently the model catalog)
 * so each `compileAgentManifest` invocation pays the load cost once and
 * reuses the cache across all of its child compilations.
 */
export interface ManifestCompileContext {
  readonly diagnostics: CompilerDiagnostic[];
  readonly externalDependencyPlanSession: CompiledExternalDependencyPlanSession;
  readonly modelCatalog: CompiledRuntimeModelCatalogLoader;
  readonly moduleLoader: AgentModuleNamespaceLoader;
  readonly registry?: AgentSourceRegistry;
}

export interface ModuleBackedDefinitionLoadOptions {
  readonly binding: CompiledModuleBinding;
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
  readonly displayPath?: string;
  readonly binding: CompiledModuleBinding;
  readonly kind: string;
  readonly moduleLoader?: AgentModuleNamespaceLoader;
  readonly source: ModuleSourceRef;
}): Promise<unknown> {
  if (input.binding.logicalPath !== input.source.logicalPath) {
    throw new Error(
      `Cannot load ${input.kind} source "${input.source.sourceId}" at "${input.source.logicalPath}" from binding "${input.binding.logicalPath}".`,
    );
  }
  const moduleLoader = input.moduleLoader ?? createAgentModuleNamespaceLoader();
  const moduleNamespace = await moduleLoader.load(input.binding.backing, {
    captureExternalDependencyWitnesses: input.kind === "agent config",
  });
  await moduleLoader.verifyExternalDependencies?.();
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
    const definition = await materializeAuthoredModuleExport(exportValue);
    if (typeof exportValue === "function") {
      await moduleLoader.verifyExternalDependencies?.();
    }
    return definition;
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
