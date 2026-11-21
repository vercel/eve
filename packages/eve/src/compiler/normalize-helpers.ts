import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledDefinition, CompiledDefinitionKind } from "#compiler/manifest.js";
import { assertDynamicSentinelKeys, isDynamicSentinel } from "#dynamic/definition.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import {
  type AgentModuleBinding,
  type AgentSourceRegistry,
  type AgentSourceOwner,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";
import type { CompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";

const SANDBOX_SELECTOR_MARKER = Symbol.for("eve.sandbox-selector");

export interface ManifestCompileContext {
  readonly modelCatalog: CompiledRuntimeModelCatalogLoader;
  readonly registries: readonly AgentSourceRegistry[];
}

export interface ModuleBackedDefinitionLoadOptions {
  readonly binding: AgentModuleBinding;
  readonly loadNamespace: CompiledBindingNamespaceLoader;
}

export interface SourceDefinitionCompileOptions {
  readonly binding?: AgentModuleBinding;
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

export async function loadModuleBackedDefinition(input: {
  readonly binding: AgentModuleBinding;
  readonly dependencyNamespaces?: Readonly<Record<string, ProgrammaticModuleNamespace>>;
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
  assertAuthoredExportPresent(moduleNamespace, input);
  const exportValue = getAuthoredModuleExport(moduleNamespace, input.source);

  if (
    input.kind === "sandbox" &&
    typeof exportValue === "function" &&
    Reflect.get(exportValue, SANDBOX_SELECTOR_MARKER) === true
  ) {
    return exportValue;
  }

  try {
    return await materializeAuthoredModuleExport(exportValue);
  } catch (error) {
    if (input.kind === "sandbox" && typeof exportValue === "function") {
      throw new Error(
        `Failed to execute the sandbox export "${input.source.exportName ?? "default"}" from "${input.displayPath ?? input.source.logicalPath}" as a zero-argument definition factory. Runtime selectors must be passed to defineSandbox(...): ${toErrorMessage(error)}`,
      );
    }
    throw new Error(
      `Failed to execute the ${input.kind} export "${input.source.exportName ?? "default"}" from "${input.displayPath ?? input.source.logicalPath}": ${toErrorMessage(error)}`,
    );
  }
}

function assertAuthoredExportPresent(
  moduleNamespace: Record<string, unknown>,
  input: { readonly displayPath?: string; readonly kind: string; readonly source: ModuleSourceRef },
): void {
  const exportName = input.source.exportName ?? "default";
  if (Object.hasOwn(moduleNamespace, exportName)) return;
  const namedExports = Object.keys(moduleNamespace).filter((name) => name !== "__esModule");
  throw new Error(
    `"${input.displayPath ?? input.source.logicalPath}" has no ${exportName === "default" ? "default" : `"${exportName}"`} export${
      namedExports.length === 0
        ? ""
        : `; it exports ${namedExports.map((name) => `"${name}"`).join(", ")}`
    }. Export the ${input.kind} definition as ${exportName === "default" ? "the default export" : `"${exportName}"`}.`,
  );
}

export function compiledDefinition(
  kind: CompiledDefinitionKind,
  source: ModuleSourceRef,
  slug: string,
  extra: Pick<CompiledDefinition, "description" | "eventNames"> = {},
): CompiledDefinition {
  return {
    ...(source.exportName !== undefined && { exportName: source.exportName }),
    ...extra,
    kind,
    logicalPath: source.logicalPath,
    slug,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}

export function dynamicDefinition(
  kind: CompiledDefinitionKind,
  source: ModuleSourceRef,
  value: unknown,
  slug: string,
): CompiledDefinition | undefined {
  if (!isDynamicSentinel(value)) return undefined;
  assertDynamicSentinelKeys(
    value,
    `Expected the ${kind} export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  return compiledDefinition(kind, source, slug);
}
