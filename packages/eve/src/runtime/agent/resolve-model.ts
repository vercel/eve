import type { LanguageModel } from "ai";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveBootstrapRuntimeModel } from "#runtime/agent/bootstrap-model.js";
import {
  resolveMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";

export { shouldMockAuthoredRuntimeModels };

/** Loaded compiled-module scope used to resolve source-backed runtime models. */
export interface RuntimeModelResolutionScope {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string | undefined;
}

/**
 * Resolves one runtime model reference into the active language model.
 */
export async function resolveRuntimeModelReference(
  reference: RuntimeModelReference,
  scope?: RuntimeModelResolutionScope,
): Promise<LanguageModel> {
  const bootstrapModel = resolveBootstrapRuntimeModel(reference);

  if (bootstrapModel !== null) {
    return bootstrapModel;
  }

  const mockModel = resolveMockAuthoredRuntimeModel(reference);

  if (mockModel !== null) {
    return mockModel;
  }

  if (isSourceBackedRuntimeModelReference(reference)) {
    return await loadSourceBackedRuntimeModelReference(reference, scope);
  }

  return reference.id;
}

async function loadSourceBackedRuntimeModelReference(
  reference: RuntimeModelReference & {
    readonly source: NonNullable<RuntimeModelReference["source"]>;
  },
  scope: RuntimeModelResolutionScope | undefined,
): Promise<LanguageModel> {
  if (scope === undefined) {
    throw new Error(
      `Expected a compiled module-map scope to resolve the authored runtime model "${reference.id}".`,
    );
  }

  const definition = await loadResolvedModuleExport({
    definition: reference.source,
    kindLabel: `runtime model "${reference.id}"`,
    moduleMap: scope.moduleMap,
    nodeId: scope.nodeId,
  });
  const normalizedDefinition = normalizeAgentDefinition(
    definition,
    `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to match the public eve shape.`,
  );
  const model = normalizedDefinition.model;

  if (model === undefined) {
    throw new Error(
      `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to provide a runtime model.`,
    );
  }

  return model;
}

function isSourceBackedRuntimeModelReference(
  reference: RuntimeModelReference,
): reference is RuntimeModelReference & {
  readonly source: NonNullable<RuntimeModelReference["source"]>;
} {
  return reference.source !== undefined;
}
