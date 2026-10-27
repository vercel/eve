import { localGatewayModel } from "#internal/model-auth/transport.js";
import type { LanguageModel } from "ai";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  normalizeAgentDefinition,
  normalizeAgentPromptCache,
} from "#internal/authored-definition/core.js";
import {
  formatLanguageModelGatewayId,
  isRuntimeLanguageModel,
  isAgentReasoningDefinition,
} from "#internal/runtime-model.js";
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
import {
  lookupCatalogModelByProviderModelId,
  lookupCatalogModelBySlug,
  type ModelCatalogEntry,
  type ModelMetadata,
} from "#internal/model-catalog.js";

export { shouldMockAuthoredRuntimeModels };

/** A deterministic authoring or selection error that retrying cannot repair. */
export class InvalidRuntimeModelSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidRuntimeModelSelectionError";
  }
}

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

  return localGatewayModel(reference.id) ?? reference.id;
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
  const model =
    reference.sourceField === "compaction.model"
      ? normalizedDefinition.compaction?.model
      : normalizedDefinition.model;

  if (model === undefined) {
    throw new Error(
      `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to provide a runtime model at "${reference.sourceField ?? "model"}".`,
    );
  }

  if (isDynamicModelDefinition(model)) {
    throw new Error(
      `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to provide a static runtime model.`,
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

export async function resolveRuntimeModelSelection(input: {
  readonly durability: "durable" | "live";
  /** The build's model metadata snapshot, read only when the selection omits its context window. */
  readonly modelMetadata: () => Promise<ModelMetadata>;
  readonly selection: PublicAgentDynamicModelResult;
}): Promise<ResolvedRuntimeModelSelection> {
  if (input.selection === null || input.selection === undefined) {
    throw new InvalidRuntimeModelSelectionError(
      "The dynamic model returned no model. Return a model ID, a provider model, or { model, reasoning?, modelContextWindowTokens?, modelOptions? }.",
    );
  }

  let selection: PublicAgentModelSelectionDefinition;
  let providerOptions: Record<string, JsonObject> | undefined;
  let promptCache: ReturnType<typeof normalizeAgentPromptCache> | undefined;
  try {
    selection = normalizeDynamicModelSelection(input.selection);
    validateDynamicModelSelection(selection);
    providerOptions =
      selection.modelOptions?.providerOptions === undefined
        ? undefined
        : parseProviderOptionsRecord(selection.modelOptions.providerOptions);
    promptCache =
      selection.modelOptions?.promptCache === undefined
        ? undefined
        : normalizeAgentPromptCache(
            selection.modelOptions.promptCache,
            "Dynamic model resolver returned an invalid selection.",
          );
  } catch (error) {
    throw invalidSelectionError(error);
  }

  const selectedModel = selection.model;
  if (typeof selectedModel === "string") {
    const id = formatLanguageModelGatewayId(selectedModel);
    if (promptCache !== undefined) throw gatewayPromptCacheError(id);
    const contextWindowTokens =
      selection.modelContextWindowTokens ??
      (
        await lookupModelMetadata(input.modelMetadata, id, (metadata) =>
          lookupCatalogModelBySlug(metadata, id),
        )
      ).contextWindowTokens;
    return {
      reference: {
        id,
        contextWindowTokens,
        providerOptions,
        reasoning: selection.reasoning,
      },
    };
  }

  validateRuntimeLanguageModel(selectedModel);
  if (input.durability === "durable") {
    throw new InvalidRuntimeModelSelectionError(
      'Dynamic model selection returned a provider object, but durable model selections must be serializable. Return a model id string, or use a "beforeModel" model resolver.',
    );
  }

  const formattedId = formatLanguageModelGatewayId(selectedModel);
  const routesThroughGateway = selectedModel.provider.split(".")[0] === "gateway";
  if (promptCache !== undefined && routesThroughGateway) {
    throw gatewayPromptCacheError(formattedId);
  }
  // A Gateway instance carries its Gateway model id, as a string selection does.
  let id = routesThroughGateway ? selectedModel.modelId : formattedId;
  let contextWindowTokens = selection.modelContextWindowTokens;
  if (contextWindowTokens === undefined) {
    const entry = await lookupModelMetadata(input.modelMetadata, id, (metadata) =>
      routesThroughGateway
        ? lookupCatalogModelBySlug(metadata, selectedModel.modelId)
        : lookupCatalogModelByProviderModelId(
            metadata,
            selectedModel.provider,
            selectedModel.modelId,
          ),
    );
    // A direct provider model takes its Gateway slug, as the compiler names a static one.
    if (!routesThroughGateway) id = entry.slug;
    contextWindowTokens = entry.contextWindowTokens;
  }

  return {
    model: selectedModel,
    reference: {
      id,
      contextWindowTokens,
      promptCache,
      providerOptions,
      reasoning: selection.reasoning,
    },
  };
}

function invalidSelectionError(error: unknown): InvalidRuntimeModelSelectionError {
  if (error instanceof InvalidRuntimeModelSelectionError) return error;
  return new InvalidRuntimeModelSelectionError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function gatewayPromptCacheError(modelId: string): Error {
  return new InvalidRuntimeModelSelectionError(
    `Dynamic model resolver returned modelOptions.promptCache for "${modelId}", which routes through AI Gateway. promptCache applies only to models eve calls directly; Gateway manages its own prompt caching through providerOptions.gateway.caching.`,
  );
}

async function lookupModelMetadata(
  loadModelMetadata: () => Promise<ModelMetadata>,
  modelLabel: string,
  find: (metadata: ModelMetadata) => ModelCatalogEntry | null,
): Promise<ModelCatalogEntry> {
  const metadata = await loadModelMetadata();
  const entry = find(metadata);
  if (entry !== null) return entry;
  throw new InvalidRuntimeModelSelectionError(
    metadata.fetchedAt === null
      ? `Cannot select model "${modelLabel}" because this build couldn't read the AI Gateway model catalog, so it has no context window for the model. Return modelContextWindowTokens with this selection, or rebuild with network access to ai-gateway.vercel.sh.`
      : `Cannot select model "${modelLabel}" because the AI Gateway model catalog this build read at ${metadata.fetchedAt} has no context window for it. Return modelContextWindowTokens with this selection for an unlisted or custom model, or rebuild to pick up a newly published one.`,
  );
}

const DYNAMIC_MODEL_SELECTION_KEYS = new Set([
  "model",
  "modelContextWindowTokens",
  "modelOptions",
  "reasoning",
]);

function validateDynamicModelSelection(selection: PublicAgentModelSelectionDefinition): void {
  const unknownKeys = Object.keys(selection).filter(
    (key) => !DYNAMIC_MODEL_SELECTION_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `A dynamic model returns only runtime settings: model, reasoning, modelContextWindowTokens, and modelOptions. It returned ${unknownKeys.map((key) => `"${key}"`).join(", ")}, which can't vary per session; declare ${unknownKeys.length === 1 ? "it" : "them"} on defineAgent() instead.`,
    );
  }

  if (selection.reasoning !== undefined && !isAgentReasoningDefinition(selection.reasoning)) {
    throw new Error(
      "Dynamic model resolver returned an invalid reasoning effort. Expected provider-default, none, minimal, low, medium, high, or xhigh.",
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

  if (typeof selection.model === "string" && selection.model.trim() === "") {
    throw new Error("Dynamic model resolver returned an empty model id.");
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
    throw new InvalidRuntimeModelSelectionError(
      "Dynamic model resolver returned an invalid model. Return an AI Gateway model id string, an AI SDK language model, or { model, modelContextWindowTokens?, modelOptions? }.",
    );
  }
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
