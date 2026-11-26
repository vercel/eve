import { relative, resolve } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { isDefinedAgent } from "#public/definitions/agent.js";
import { isDynamicSentinel } from "#dynamic/definition.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { isMockModel } from "#internal/mock-model-identity.js";
import { isDefinedModel } from "#models/definition.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";
import {
  assertCompactionStrategyCompatible,
  modelCompaction,
} from "#shared/compaction-strategy.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  isDynamicModelDefinition,
  type AgentExperimentalDefinition,
  type AgentPromptCacheDefinition,
  type AgentToolExposure,
  type ModelRouting,
  type PublicAgentTurnModelDefinition,
} from "#shared/agent-definition.js";
import type { CompiledAgentDefinition, CompiledRuntimeModelReference } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
import type { AgentModuleBinding } from "#compiler/source-graph.js";
import { createCompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export async function compileAgentConfig(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: {
    readonly binding: AgentModuleBinding;
    readonly definition?: unknown;
    readonly source: ModuleSourceRef;
  },
): Promise<CompiledAgentDefinition> {
  const configModule = options.source;
  const configModulePath = formatAgentConfigModulePath(manifest, configModule, options.binding);
  const authored = Object.hasOwn(options, "definition")
    ? options.definition
    : await loadModuleBackedDefinition({
        binding: options.binding,
        displayPath: configModulePath,
        kind: "agent config",
        loadNamespace: createCompiledBindingNamespaceLoader({
          appRoot: manifest.appRoot,
          bindings: { [configModule.sourceId]: options.binding },
          registries: context.registries,
        }),
        source: configModule,
      });
  if (!isDefinedAgent(authored) && !isDynamicSentinel(authored)) {
    throw new Error(`Export defineAgent({...}) from "${configModulePath}".`);
  }
  const definition = normalizeAgentDefinition(
    authored,
    `Expected the agent config export "${configModule.exportName ?? "default"}" from "${configModulePath}" to match the public eve shape.`,
  );
  const dynamicModelDefinition = isDynamicModelDefinition(definition.model)
    ? definition.model
    : undefined;
  const model =
    dynamicModelDefinition === undefined
      ? await normalizeAuthoredModelReference({
          modelCatalog: context.modelCatalog,
          purpose: "the primary compaction trigger model",
          contextWindowTokens: definition.modelContextWindowTokens,
          promptCache: definition.modelOptions?.promptCache,
          providerOptions: definition.modelOptions?.providerOptions,
          source: configModule,
          sourcePath: configModulePath,
          value: definition.model as PublicAgentTurnModelDefinition,
        })
      : undefined;
  const compaction: {
    model?: CompiledRuntimeModelReference;
    thresholdPercent?: number;
  } = {};

  const compiledConfig: {
    approval?: boolean;
    build?: CompiledAgentDefinition["build"];
    compaction: {
      model?: CompiledRuntimeModelReference;
      thresholdPercent?: number;
    };
    defaultTools?: boolean;
    description?: string;
    experimental?: CompiledAgentDefinition["experimental"];
    name: string;
    reasoning?: CompiledAgentDefinition["reasoning"];
    source: ModuleSourceRef;
    tool?: AgentToolExposure;
    limits?: CompiledAgentDefinition["limits"];
  } = {
    compaction,
    name: manifest.agentId,
    source: { ...configModule },
  };

  if (definition.defaultTools !== undefined) {
    compiledConfig.defaultTools = definition.defaultTools;
  }

  if (definition.description !== undefined) {
    compiledConfig.description = definition.description;
  }

  if (definition.approval !== undefined) {
    compiledConfig.approval = true;
  }

  let dynamicModel: CompiledAgentDefinition["dynamicModel"] | undefined;
  if (dynamicModelDefinition !== undefined) {
    dynamicModel = {
      exportName: configModule.exportName,
      sourceKind: "module",
      logicalPath: configModule.logicalPath,
      sourceId: configModule.sourceId,
    };
  }

  const compactionInput = definition.experimental?.compaction;
  if (compactionInput !== undefined && dynamicModelDefinition === undefined) {
    rejectCompactionMismatch(
      compactionInput,
      definition.model as PublicAgentTurnModelDefinition,
      configModulePath,
    );
  }
  const experimental = normalizeExperimentalDefinition(definition.experimental);
  if (experimental !== undefined) {
    compiledConfig.experimental = experimental;
  }

  if (definition.build !== undefined) {
    compiledConfig.build = {
      externalDependencies:
        definition.build.externalDependencies === undefined
          ? undefined
          : [...definition.build.externalDependencies],
    };
  }

  if (definition.reasoning !== undefined) {
    compiledConfig.reasoning = definition.reasoning;
  }

  if (definition.tool !== undefined) {
    compiledConfig.tool = definition.tool;
  }

  if (definition.limits !== undefined) {
    compiledConfig.limits = {
      sessionTimeoutMs: definition.limits.sessionTimeoutMs,
      sessionUsage:
        typeof definition.limits.sessionUsage === "function"
          ? true
          : definition.limits.sessionUsage,
    };
  }

  if (definition.compaction?.model !== undefined) {
    compaction.model = await normalizeAuthoredModelReference({
      modelCatalog: context.modelCatalog,
      purpose: "the compaction summary model",
      contextWindowTokens: definition.compaction.modelContextWindowTokens,
      providerOptions: definition.modelOptions?.providerOptions,
      source: configModule,
      sourceField: "compaction.model",
      sourcePath: configModulePath,
      value: definition.compaction.model,
    });
  }

  if (definition.compaction?.threshold !== undefined) {
    compaction.thresholdPercent = definition.compaction.threshold;
  }

  if (dynamicModel !== undefined) {
    return { ...compiledConfig, dynamicModel };
  }

  if (model === undefined) {
    throw new Error("Expected a static agent model to compile to a concrete model reference.");
  }

  return { ...compiledConfig, model };
}

function rejectCompactionMismatch(
  compactionInput: NonNullable<AgentExperimentalDefinition["compaction"]>,
  model: PublicAgentTurnModelDefinition,
  sourcePath: string,
): void {
  if (isDefinedModel(model)) return;
  const compaction = modelCompaction(compactionInput, "experimental.compaction");
  try {
    assertCompactionStrategyCompatible(
      compaction,
      typeof model === "string"
        ? { modelId: model, provider: "gateway" }
        : { modelId: model.modelId, provider: model.provider },
    );
  } catch (error) {
    throw new Error(`In "${sourcePath}", ${toErrorMessage(error)}`, { cause: error });
  }
}

function normalizeExperimentalDefinition(
  experimental: AgentExperimentalDefinition | undefined,
): CompiledAgentDefinition["experimental"] | undefined {
  if (experimental === undefined) {
    return undefined;
  }

  const compiledExperimental: Mutable<NonNullable<CompiledAgentDefinition["experimental"]>> = {};

  if (experimental.compaction !== undefined) {
    compiledExperimental.compaction = true;
  }

  if (experimental.workflow !== undefined) {
    compiledExperimental.workflow = {
      modelCallsPerStep: experimental.workflow.modelCallsPerStep,
      retention: experimental.workflow.retention,
      world: experimental.workflow.world,
    };
  }

  return compiledExperimental;
}

async function normalizeAuthoredModelReference(input: {
  readonly modelCatalog: ManifestCompileContext["modelCatalog"];
  readonly purpose: string;
  readonly contextWindowTokens?: number;
  readonly promptCache?: AgentPromptCacheDefinition;
  readonly providerOptions?: Record<string, JsonObject>;
  readonly source?: ModuleSourceRef;
  readonly sourceField?: CompiledRuntimeModelReference["sourceField"];
  readonly sourcePath?: string;
  readonly value: PublicAgentTurnModelDefinition;
}): Promise<CompiledRuntimeModelReference> {
  if (typeof input.value === "string") {
    const routing = classifyModelRouting(input.value, input.providerOptions);
    rejectGatewayPromptCache(input, routing);
    const reference: CompiledRuntimeModelReference = {
      id: formatLanguageModelGatewayId(input.value),
      providerOptions: parseProviderOptionsRecord(input.providerOptions),
      routing,
    };
    if (input.promptCache !== undefined) reference.promptCache = input.promptCache;
    return await withCompiledRuntimeModelLimits(reference, input);
  }

  const source = input.source;

  if (source === undefined) {
    throw new Error(
      `Expected ${input.purpose} to provide a valid AI SDK language model reference.`,
    );
  }

  const sourceRef = {
    exportName: source.exportName,
    sourceKind: "module" as const,
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
  };

  if (isDefinedModel(input.value)) {
    const reference: CompiledRuntimeModelReference = {
      id: input.value.id,
      source: sourceRef,
      providerOptions: parseProviderOptionsRecord(input.providerOptions),
      routing: classifyModelRouting(input.value, input.providerOptions),
    };
    if (input.sourceField !== undefined) reference.sourceField = input.sourceField;
    if (input.promptCache !== undefined) reference.promptCache = input.promptCache;
    return await withCompiledRuntimeModelLimits(reference, input);
  }

  const languageModel = input.value;
  const specificationVersion = languageModel.specificationVersion;

  if (
    specificationVersion !== "v2" &&
    specificationVersion !== "v3" &&
    specificationVersion !== "v4"
  ) {
    throw new Error(
      `Expected the authored agent config export "${source.exportName ?? "default"}" from "${input.sourcePath ?? source.logicalPath}" to provide a valid AI SDK language model.`,
    );
  }

  if (
    typeof languageModel.provider !== "string" ||
    typeof languageModel.modelId !== "string" ||
    typeof languageModel.doGenerate !== "function" ||
    typeof languageModel.doStream !== "function"
  ) {
    throw new Error(
      `Expected the authored agent config export "${source.exportName ?? "default"}" from "${input.sourcePath ?? source.logicalPath}" to provide a valid AI SDK language model.`,
    );
  }

  const routing = classifyModelRouting(languageModel, input.providerOptions);
  rejectGatewayPromptCache(input, routing);
  const sourceBackedModel: CompiledRuntimeModelReference = {
    id: formatLanguageModelGatewayId(languageModel),
    source: sourceRef,
    providerOptions: parseProviderOptionsRecord(input.providerOptions),
    routing,
  };
  if (input.sourceField !== undefined) sourceBackedModel.sourceField = input.sourceField;
  if (input.promptCache !== undefined) sourceBackedModel.promptCache = input.promptCache;

  if (input.contextWindowTokens === undefined) {
    if (isChatGptModelRouting(sourceBackedModel.routing)) {
      return {
        ...sourceBackedModel,
        contextWindowTokens: 200_000,
      };
    }

    if (isMockModel(languageModel)) {
      return {
        ...sourceBackedModel,
        contextWindowTokens: 1_000_000,
      };
    }

    try {
      const providerResult = await input.modelCatalog.getByProviderModelId(
        languageModel.provider,
        languageModel.modelId,
      );

      if (providerResult) {
        return {
          ...sourceBackedModel,
          id: providerResult.slug,
          contextWindowTokens: providerResult.contextWindowTokens,
          maxOutputTokens: providerResult.maxOutputTokens,
        };
      }
    } catch {}
  }

  return await withCompiledRuntimeModelLimits(sourceBackedModel, input);
}

function rejectGatewayPromptCache(
  input: {
    readonly promptCache?: AgentPromptCacheDefinition;
    readonly sourcePath?: string;
    readonly value: PublicAgentTurnModelDefinition;
  },
  routing: ModelRouting,
): void {
  if (input.promptCache === undefined || routing.kind !== "gateway") return;
  if (routing.target === "anthropic") return;
  throw new Error(
    `${input.sourcePath ?? "agent.ts"}: modelOptions.promptCache applies to Anthropic models and to models eve calls directly, but "${formatLanguageModelGatewayId(input.value)}" routes through AI Gateway, which manages its own prompt caching. Remove promptCache, or configure Gateway caching with providerOptions.gateway.caching.`,
  );
}

function formatAgentConfigModulePath(
  manifest: AgentSourceManifest,
  configModule: ModuleSourceRef,
  binding: AgentModuleBinding,
): string {
  if (binding.backing.kind === "programmatic") return configModule.logicalPath;
  return normalizeLogicalPath(
    relative(resolveTopLevelAgentRoot(manifest), binding.backing.sourcePath),
  );
}

function resolveTopLevelAgentRoot(manifest: AgentSourceManifest): string {
  const appRoot = resolve(manifest.appRoot);
  const nestedAgentRoot = resolve(appRoot, "agent");
  const agentRoot = resolve(manifest.agentRoot);

  if (isPathInsideOrEqual(agentRoot, nestedAgentRoot)) {
    return nestedAgentRoot;
  }

  return appRoot;
}

async function withCompiledRuntimeModelLimits(
  model: CompiledRuntimeModelReference,
  input: {
    readonly modelCatalog: ManifestCompileContext["modelCatalog"];
    readonly purpose: string;
    readonly contextWindowTokens?: number;
    readonly source?: ModuleSourceRef;
  },
): Promise<CompiledRuntimeModelReference> {
  if (input.contextWindowTokens !== undefined) {
    return {
      ...model,
      contextWindowTokens: input.contextWindowTokens,
    };
  }

  const limits = await input.modelCatalog.getModelLimits(model.id).catch((error: unknown) => {
    throw new Error(
      `Failed to load AI Gateway model metadata for ${input.purpose} "${model.id}". ${toErrorMessage(error)}`,
      { cause: error },
    );
  });

  if (limits === null) {
    throw new Error(
      `Cannot compile agent compaction because ${input.purpose} "${model.id}" does not have known AI Gateway context window metadata.`,
    );
  }

  return {
    ...model,
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
  };
}

function parseProviderOptionsRecord(
  value: Record<string, JsonObject> | undefined,
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
