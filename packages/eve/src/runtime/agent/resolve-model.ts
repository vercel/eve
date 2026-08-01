import type { LanguageModel } from "ai";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type {
  RuntimeDynamicModelReference,
  RuntimeModelReference,
} from "#runtime/agent/bootstrap.js";
import { resolveBootstrapRuntimeModel } from "#runtime/agent/bootstrap-model.js";
import {
  resolveMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import {
  isDynamicModelDefinition,
  type AgentModelOptionsDefinition,
  type PublicAgentDynamicModelDefinition,
  type PublicAgentDynamicModelResult,
  type PublicAgentModelSelectionDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export { shouldMockAuthoredRuntimeModels };

/** Loaded compiled-module scope used to resolve source-backed runtime models. */
export interface RuntimeModelResolutionScope {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string | undefined;
}

export interface ResolvedRuntimeModelSelection {
  /** Live provider instance; absent for string selections, which resolve through the reference so mock/bootstrap adapters keep precedence. */
  readonly model?: LanguageModel;
  readonly reference: RuntimeModelReference;
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

  if (isDynamicModelDefinition(model)) {
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

export async function loadDynamicRuntimeModelDefinition(input: {
  readonly dynamicModel: RuntimeDynamicModelReference;
  readonly scope: RuntimeModelResolutionScope;
}): Promise<PublicAgentDynamicModelDefinition> {
  const definition = await loadResolvedModuleExport({
    definition: input.dynamicModel,
    kindLabel: "dynamic runtime model",
    moduleMap: input.scope.moduleMap,
    nodeId: input.scope.nodeId,
  });
  const normalizedDefinition = normalizeAgentDefinition(
    definition,
    `Expected the authored agent config export "${input.dynamicModel.exportName ?? "default"}" from "${input.dynamicModel.logicalPath}" to match the public eve shape.`,
  );
  const authoredModel = normalizedDefinition.model;

  if (!isDynamicModelDefinition(authoredModel)) {
    throw new Error(
      `Expected the authored agent config export "${input.dynamicModel.exportName ?? "default"}" from "${input.dynamicModel.logicalPath}" to provide a dynamic model definition.`,
    );
  }

  return authoredModel;
}

export function normalizeDynamicRuntimeModelResult(input: {
  readonly fallback: RuntimeModelReference;
  readonly result: NonNullable<PublicAgentDynamicModelResult>;
}): ResolvedRuntimeModelSelection {
  const selection = normalizeDynamicModelSelection(input.result);
  validateDynamicModelSelection(selection);
  const providerOptions =
    selection.modelOptions?.providerOptions === undefined
      ? input.fallback.providerOptions
      : parseProviderOptionsRecord(selection.modelOptions.providerOptions);
  // Never inherited from the fallback: a different model's window is not a safe guess.
  const contextWindowTokens = selection.modelContextWindowTokens;

  if (typeof selection.model === "string") {
    const id = formatLanguageModelGatewayId(selection.model);
    return {
      reference: {
        id,
        contextWindowTokens,
        providerOptions,
      },
    };
  }

  validateRuntimeLanguageModel(selection.model);

  return {
    model: selection.model,
    reference: {
      id: formatLanguageModelGatewayId(selection.model),
      contextWindowTokens,
      providerOptions,
    },
  };
}

const DYNAMIC_MODEL_SELECTION_KEYS = new Set(["model", "modelContextWindowTokens", "modelOptions"]);

function validateDynamicModelSelection(selection: PublicAgentModelSelectionDefinition): void {
  const unknownKeys = Object.keys(selection).filter(
    (key) => !DYNAMIC_MODEL_SELECTION_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Dynamic model resolver returned a selection with unknown key(s): ${unknownKeys.join(", ")}. Expected { model, modelContextWindowTokens?, modelOptions? }.`,
    );
  }

  const contextWindowTokens = selection.modelContextWindowTokens;
  if (
    contextWindowTokens !== undefined &&
    (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0)
  ) {
    throw new Error(
      "Dynamic model resolver returned an invalid modelContextWindowTokens value. Expected a positive integer.",
    );
  }
}

function normalizeDynamicModelSelection(
  result: NonNullable<PublicAgentDynamicModelResult>,
): PublicAgentModelSelectionDefinition {
  if (isModelSelectionDefinition(result)) {
    return result;
  }

  return { model: result as PublicAgentStaticModelDefinition };
}

function isModelSelectionDefinition(value: unknown): value is PublicAgentModelSelectionDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "model" in value &&
    !isRuntimeLanguageModel(value)
  );
}

function validateRuntimeLanguageModel(model: unknown): asserts model is LanguageModel {
  if (!isRuntimeLanguageModel(model)) {
    throw new Error(
      "Dynamic model resolver returned an invalid model. Return an AI Gateway model id string, an AI SDK language model, or { model, modelContextWindowTokens?, modelOptions? }.",
    );
  }
}

export function isRuntimeLanguageModel(value: unknown): value is LanguageModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const model = value as {
    specificationVersion?: unknown;
    provider?: unknown;
    modelId?: unknown;
    doGenerate?: unknown;
    doStream?: unknown;
  };

  return (
    (model.specificationVersion === "v2" ||
      model.specificationVersion === "v3" ||
      model.specificationVersion === "v4") &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}

function parseProviderOptionsRecord(
  value: AgentModelOptionsDefinition["providerOptions"],
): Record<string, JsonObject> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized: Record<string, JsonObject> = {};

  for (const [provider, entry] of Object.entries(value)) {
    normalized[provider] = parseJsonObject(entry);
  }

  return normalized;
}
