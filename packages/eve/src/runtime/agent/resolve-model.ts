import type { LanguageModel } from "ai";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { isExperimentalCodexModel } from "#shared/codex-subscription-model.js";
import { isLanguageModelValue } from "#shared/language-model.js";
import { aiGatewayEndpoint } from "#internal/model-auth/endpoint/ai-gateway.js";
import { codexEndpoint } from "#internal/model-auth/endpoint/codex/endpoint.js";
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

  if (reference.transport === "codex") {
    return codexEndpoint.createModel(reference);
  }

  if (isSourceBackedRuntimeModelReference(reference)) {
    return await loadSourceBackedRuntimeModelReference(reference, scope);
  }

  return aiGatewayEndpoint.createModel(reference);
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

  // A source-backed reference to an experimental_codex value only compiles in
  // production, where the compiler selected the deployable fallback route.
  if (isExperimentalCodexModel(model)) {
    if (!isLanguageModelValue(model.fallback)) {
      throw new Error(
        `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to provide a deployable experimental_codex fallback: an AI SDK language model or a model id string.`,
      );
    }
    return model.fallback;
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
