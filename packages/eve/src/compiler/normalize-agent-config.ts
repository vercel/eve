import { isAbsolute, relative, resolve } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { serializeOutputSchema } from "#shared/tool-schema.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  type AgentExperimentalDefinition,
  isDynamicModelDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import {
  ALLOWED_DYNAMIC_MODEL_EVENTS,
  type DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";
import type { CompiledAgentDefinition, CompiledRuntimeModelReference } from "#compiler/manifest.js";
import type { CompiledRuntimeModelLimits } from "#compiler/model-catalog.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import { compileWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";
import type { BuiltInWorkflowWorldTarget } from "#internal/workflow/world-target.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Compiles the agent-level configuration (model, compaction, build,
 * workspace) for one authored agent node.
 */
export async function compileAgentConfig(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: {
    readonly allowWorkflowRuntime?: boolean;
    readonly binding: CompiledModuleBinding;
    readonly definition: unknown;
    readonly workflowWorld?: {
      readonly defaultTarget: BuiltInWorkflowWorldTarget;
      readonly setPlan: (plan: CompiledWorkflowWorldPlan) => void;
    };
  },
): Promise<CompiledAgentDefinition> {
  const configModule = manifest.configModule;
  if (configModule === undefined) {
    throw new Error(`Agent "${manifest.agentId}" has no selected agent config module.`);
  }
  if (options.binding.logicalPath !== configModule.logicalPath) {
    throw new Error(
      `Selected agent config binding "${configModule.sourceId}" targets "${options.binding.logicalPath}" instead of "${configModule.logicalPath}".`,
    );
  }
  const configSourceLocator = formatAgentConfigSourceLocator(manifest, options.binding);
  const definition = normalizeAgentDefinition(
    options.definition,
    `Expected the agent config export "${configModule.exportName ?? "default"}" from "${configSourceLocator}" to match the public eve shape.`,
  );
  const authoredWorkflowWorld = definition.experimental?.workflow?.world;
  if (definition.experimental?.workflow !== undefined && options.allowWorkflowRuntime !== true) {
    throw new Error(
      `Workflow runtime configuration is only supported on the root agent config. Remove "experimental.workflow" from "${manifest.agentId}".`,
    );
  }
  if (options.workflowWorld !== undefined) {
    options.workflowWorld.setPlan(
      await compileWorkflowWorldPlan({
        appRoot: manifest.appRoot,
        selection: authoredWorkflowWorld === undefined ? "host-default" : "configured",
        target: authoredWorkflowWorld ?? options.workflowWorld.defaultTarget,
      }),
    );
  }
  const dynamicModelDefinition = isDynamicModelDefinition(definition.model)
    ? definition.model
    : undefined;
  const model =
    dynamicModelDefinition === undefined
      ? await normalizeAuthoredModelReference({
          modelCatalog: context.modelCatalog,
          purpose: "the primary compaction trigger model",
          contextWindowTokens: definition.modelContextWindowTokens,
          providerOptions: definition.modelOptions?.providerOptions,
          source: configModule,
          sourceLocator: configSourceLocator,
          value: definition.model as PublicAgentStaticModelDefinition,
        })
      : undefined;
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
    experimental?: CompiledAgentDefinition["experimental"];
    name: string;
    outputSchema?: JsonObject;
    reasoning?: CompiledAgentDefinition["reasoning"];
    source: ModuleSourceRef;
    limits?: CompiledAgentDefinition["limits"];
  } = {
    compaction,
    name: manifest.agentId,
    source: {
      exportName: configModule.exportName,
      sourceKind: "module",
      logicalPath: configModule.logicalPath,
      sourceId: configModule.sourceId,
    },
  };

  if (definition.description !== undefined) {
    compiledConfig.description = definition.description;
  }

  let dynamicModel: CompiledAgentDefinition["dynamicModel"] | undefined;
  if (dynamicModelDefinition !== undefined) {
    const eventNames = Object.keys(dynamicModelDefinition.events);
    const unsupportedEvent = eventNames.find(
      (eventName) => !ALLOWED_DYNAMIC_MODEL_EVENTS.has(eventName),
    );
    if (unsupportedEvent !== undefined) {
      throw new Error(
        `Expected the agent config export "${configModule.exportName ?? "default"}" from "${configSourceLocator}" to use only supported dynamic model events. Unsupported event: "${unsupportedEvent}".`,
      );
    }
    dynamicModel = {
      eventNames: eventNames as DynamicToolEventName[],
      exportName: configModule.exportName,
      sourceKind: "module",
      logicalPath: configModule.logicalPath,
      sourceId: configModule.sourceId,
    };
  }

  const experimental = normalizeExperimentalDefinition({
    experimental: definition.experimental,
  });
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
    compiledConfig.outputSchema = serializeOutputSchema(definition.outputSchema);
  }

  if (definition.reasoning !== undefined) {
    compiledConfig.reasoning = definition.reasoning;
  }

  if (definition.limits !== undefined) {
    compiledConfig.limits = {
      maxInputTokensPerSession: definition.limits.maxInputTokensPerSession,
      maxOutputTokensPerSession: definition.limits.maxOutputTokensPerSession,
      sessionTimeoutMs: definition.limits.sessionTimeoutMs,
    };
  }

  if (definition.compaction?.model !== undefined) {
    compaction.model = await normalizeAuthoredModelReference({
      modelCatalog: context.modelCatalog,
      purpose: "the compaction summary model",
      contextWindowTokens: definition.compaction.modelContextWindowTokens,
      providerOptions: definition.modelOptions?.providerOptions,
      source: configModule,
      sourceLocator: configSourceLocator,
      value: definition.compaction.model,
    });
  }

  if (definition.compaction?.thresholdPercent !== undefined) {
    compaction.thresholdPercent = definition.compaction.thresholdPercent;
  }

  if (dynamicModel !== undefined) {
    return { ...compiledConfig, dynamicModel };
  }

  if (model === undefined) {
    throw new Error("Expected a static agent model to compile to a concrete model reference.");
  }

  return { ...compiledConfig, model };
}

function normalizeExperimentalDefinition(input: {
  readonly experimental: AgentExperimentalDefinition | undefined;
}): CompiledAgentDefinition["experimental"] | undefined {
  if (input.experimental === undefined) {
    return undefined;
  }

  const compiledExperimental: Mutable<NonNullable<CompiledAgentDefinition["experimental"]>> = {};

  if (input.experimental.instrumentationProviders !== undefined) {
    compiledExperimental.instrumentationProviders = input.experimental.instrumentationProviders;
  }

  if (input.experimental.subagentPersistentSessions !== undefined) {
    compiledExperimental.subagentPersistentSessions = input.experimental.subagentPersistentSessions;
  }

  if (input.experimental.tasks !== undefined) {
    compiledExperimental.tasks = input.experimental.tasks;
  }

  return Object.keys(compiledExperimental).length === 0 ? undefined : compiledExperimental;
}

async function normalizeAuthoredModelReference(input: {
  readonly modelCatalog: ManifestCompileContext["modelCatalog"];
  readonly purpose: string;
  readonly contextWindowTokens?: number;
  readonly providerOptions?: Record<string, JsonObject>;
  readonly source?: ModuleSourceRef;
  readonly sourceLocator?: string;
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
      `Expected the authored agent config export "${source.exportName ?? "default"}" from "${input.sourceLocator ?? source.logicalPath}" to provide a valid AI SDK language model.`,
    );
  }

  if (
    typeof languageModel.provider !== "string" ||
    typeof languageModel.modelId !== "string" ||
    typeof languageModel.doGenerate !== "function" ||
    typeof languageModel.doStream !== "function"
  ) {
    throw new Error(
      `Expected the authored agent config export "${source.exportName ?? "default"}" from "${input.sourceLocator ?? source.logicalPath}" to provide a valid AI SDK language model.`,
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
    // Codex models have no Gateway catalog entry, so use eve's known context limit.
    if (isChatGptModelRouting(sourceBackedModel.routing)) {
      return {
        ...sourceBackedModel,
        contextWindowTokens: 200_000,
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
          contextWindowTokens: providerResult.limits.contextWindowTokens,
          maxOutputTokens: providerResult.limits.maxOutputTokens,
        };
      }
    } catch {
      // Slug lookup below still resolves built-in limits and otherwise resurfaces the catalog error.
    }
  }

  return await withCompiledRuntimeModelLimits(sourceBackedModel, input);
}

function formatAgentConfigSourceLocator(
  manifest: AgentSourceManifest,
  binding: CompiledModuleBinding,
): string {
  if (binding.backing.kind === "programmatic") {
    return `${binding.backing.registryId}:${binding.backing.moduleId}`;
  }
  return normalizeLogicalPath(
    relative(resolveTopLevelAgentRoot(manifest), binding.backing.sourcePath),
  );
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
