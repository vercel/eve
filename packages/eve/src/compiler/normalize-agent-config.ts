import { isAbsolute, join, relative, resolve } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { normalizeJsonSchemaDefinition } from "#shared/json-schema.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  isDynamicModelDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import type { DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import type { CompiledAgentDefinition, CompiledRuntimeModelReference } from "#compiler/manifest.js";
import type { CompiledRuntimeModelLimits } from "#compiler/model-catalog.js";
import {
  loadModuleBackedDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Compiles the agent-level configuration (model, compaction, build,
 * workspace) for one authored agent node.
 */
export async function compileAgentConfig(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
): Promise<CompiledAgentDefinition> {
  const configModule = manifest.configModule;
  const configModulePath =
    configModule === undefined ? undefined : formatAgentConfigModulePath(manifest, configModule);
  const definition = normalizeAgentDefinition(
    configModule === undefined
      ? { model: DEFAULT_AGENT_MODEL_ID }
      : await loadModuleBackedDefinition({
          agentRoot: manifest.agentRoot,
          displayPath: configModulePath!,
          kind: "agent config",
          source: configModule,
        }),
    configModule === undefined
      ? `Expected the default agent config to match the public eve shape.`
      : `Expected the agent config export "${configModule.exportName ?? "default"}" from "${configModulePath}" to match the public eve shape.`,
  );
  const authoredModel = isDynamicModelDefinition(definition.model)
    ? definition.model.fallback
    : definition.model;
  const model = await normalizeAuthoredModelReference({
    modelCatalog: context.modelCatalog,
    purpose: "the primary compaction trigger model",
    contextWindowTokens: definition.modelContextWindowTokens,
    providerOptions: definition.modelOptions?.providerOptions,
    source: configModule,
    sourcePath: configModulePath,
    value: authoredModel,
  });
  const compaction: {
    model?: CompiledRuntimeModelReference;
    thresholdPercent?: number;
  } = {};

  const compiledConfig: {
    build?: CompiledAgentDefinition["build"];
    compaction: {
      model?: CompiledRuntimeModelReference;
      thresholdPercent?: number;
    };
    description?: string;
    dynamicModel?: CompiledAgentDefinition["dynamicModel"];
    experimental?: CompiledAgentDefinition["experimental"];
    model: CompiledRuntimeModelReference;
    name: string;
    outputSchema?: JsonObject;
    reasoning?: CompiledAgentDefinition["reasoning"];
    source?: ModuleSourceRef;
    limits?: CompiledAgentDefinition["limits"];
  } = {
    compaction,
    model,
    name: manifest.agentId,
  };

  if (definition.description !== undefined) {
    compiledConfig.description = definition.description;
  }

  if (isDynamicModelDefinition(definition.model)) {
    if (configModule === undefined) {
      throw new Error("Expected dynamic model definitions to be authored in agent.ts.");
    }
    compiledConfig.dynamicModel = {
      eventNames: Object.keys(definition.model.events) as DynamicToolEventName[],
      exportName: configModule.exportName,
      sourceKind: "module",
      logicalPath: configModule.logicalPath,
      sourceId: configModule.sourceId,
    };
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

  if (definition.outputSchema !== undefined) {
    compiledConfig.outputSchema = normalizeJsonSchemaDefinition(definition.outputSchema, "output");
  }

  if (definition.reasoning !== undefined) {
    compiledConfig.reasoning = definition.reasoning;
  }

  if (definition.limits !== undefined) {
    compiledConfig.limits = {
      maxInputTokensPerSession: definition.limits.maxInputTokensPerSession,
      maxOutputTokensPerSession: definition.limits.maxOutputTokensPerSession,
    };
  }

  if (configModule !== undefined) {
    compiledConfig.source = {
      exportName: configModule.exportName,
      sourceKind: "module",
      logicalPath: configModule.logicalPath,
      sourceId: configModule.sourceId,
    };
  }

  if (definition.compaction?.model !== undefined) {
    compaction.model = await normalizeAuthoredModelReference({
      modelCatalog: context.modelCatalog,
      purpose: "the compaction summary model",
      contextWindowTokens: definition.compaction.modelContextWindowTokens,
      providerOptions: definition.modelOptions?.providerOptions,
      source: configModule,
      sourcePath: configModulePath,
      value: definition.compaction.model,
    });
  }

  if (definition.compaction?.thresholdPercent !== undefined) {
    compaction.thresholdPercent = definition.compaction.thresholdPercent;
  }

  return compiledConfig;
}

function normalizeExperimentalDefinition(
  experimental: CompiledAgentDefinition["experimental"] | undefined,
): CompiledAgentDefinition["experimental"] | undefined {
  if (experimental === undefined) {
    return undefined;
  }

  const compiledExperimental: Mutable<NonNullable<CompiledAgentDefinition["experimental"]>> = {};

  if (experimental.workflow !== undefined) {
    compiledExperimental.workflow = {
      world: experimental.workflow.world,
    };
  }

  return compiledExperimental;
}

async function normalizeAuthoredModelReference(input: {
  readonly modelCatalog: ManifestCompileContext["modelCatalog"];
  readonly purpose: string;
  readonly contextWindowTokens?: number;
  readonly providerOptions?: Record<string, JsonObject>;
  readonly source?: ModuleSourceRef;
  readonly sourcePath?: string;
  readonly value: PublicAgentStaticModelDefinition;
}): Promise<CompiledRuntimeModelReference> {
  if (typeof input.value === "string") {
    return await withCompiledRuntimeModelLimits(
      {
        id: formatLanguageModelGatewayId(input.value),
        providerOptions: parseProviderOptionsRecord(input.providerOptions),
        routing: classifyModelRouting(input.value, input.providerOptions),
      },
      input,
    );
  }

  const source = input.source;

  if (source === undefined) {
    throw new Error(
      `Expected ${input.purpose} to provide a valid AI SDK language model reference.`,
    );
  }

  // While in TypeScript `input.value` is safe to use, we still validate below against runtime input.
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

  const sourceBackedModel = {
    id: formatLanguageModelGatewayId(languageModel),
    source: {
      exportName: source.exportName,
      sourceKind: "module" as const,
      logicalPath: source.logicalPath,
      sourceId: source.sourceId,
    },
    providerOptions: parseProviderOptionsRecord(input.providerOptions),
    routing: classifyModelRouting(languageModel, input.providerOptions),
  };

  if (input.contextWindowTokens === undefined) {
    const providerResult = await input.modelCatalog.getByProviderModelId(
      languageModel.provider,
      languageModel.modelId,
    );

    if (providerResult) {
      return {
        ...sourceBackedModel,
        id: providerResult.slug,
        contextWindowTokens: providerResult.limits.contextWindowTokens,
      };
    }
  }

  return await withCompiledRuntimeModelLimits(sourceBackedModel, input);
}

function formatAgentConfigModulePath(
  manifest: AgentSourceManifest,
  configModule: ModuleSourceRef,
): string {
  const configPath = join(manifest.agentRoot, configModule.logicalPath);
  return normalizeLogicalPath(relative(resolveTopLevelAgentRoot(manifest), configPath));
}

function resolveTopLevelAgentRoot(manifest: AgentSourceManifest): string {
  const appRoot = resolve(manifest.appRoot);
  const nestedAgentRoot = resolve(appRoot, "agent");
  const agentRoot = resolve(manifest.agentRoot);

  if (isPathInsideOrEqual(nestedAgentRoot, agentRoot)) {
    return nestedAgentRoot;
  }

  return appRoot;
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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

  let limits: CompiledRuntimeModelLimits | null;

  try {
    limits = await input.modelCatalog.getModelLimits(model.id);
  } catch (error) {
    throw new Error(
      `Failed to load AI Gateway model metadata for ${input.purpose} "${model.id}". ${toErrorMessage(error)}`,
    );
  }

  if (limits === null) {
    throw new Error(
      `Cannot compile agent compaction because ${input.purpose} "${model.id}" does not have known AI Gateway context window metadata.`,
    );
  }

  return {
    ...model,
    contextWindowTokens: limits.contextWindowTokens,
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
