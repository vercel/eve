import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import {
  isDynamicModelDefinition,
  type AgentLimitsDefinition,
  type AgentReasoningDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { serializeOutputSchema } from "#shared/tool-schema.js";

export interface DynamicSubagentAgentConfig {
  readonly compaction?: {
    readonly model?: DynamicSubagentModelReference;
    readonly thresholdPercent?: number;
  };
  readonly description: string;
  readonly limits?: AgentLimitsDefinition;
  readonly model: DynamicSubagentModelReference;
  readonly outputSchema?: JsonObject;
  readonly reasoning?: AgentReasoningDefinition;
}

export interface DynamicSubagentModelReference {
  readonly contextWindowTokens?: number;
  readonly id: string;
  readonly providerOptions?: Record<string, JsonObject>;
}

export function normalizeDynamicSubagentAgentConfig(input: {
  readonly name: string;
  readonly value: unknown;
}): DynamicSubagentAgentConfig {
  const message = `Dynamic subagent "${input.name}" must return defineAgent({ description, model, ... }) or null.`;
  const definition = normalizeAgentDefinition(input.value, message);

  if (!definition.description) {
    throw new Error(`${message} The "description" field is required.`);
  }
  if (definition.build !== undefined) {
    throw new Error(`${message} The "build" field cannot be selected at runtime.`);
  }
  if (definition.experimental !== undefined) {
    throw new Error(`${message} The "experimental" field cannot be selected at runtime.`);
  }
  if (isDynamicModelDefinition(definition.model)) {
    throw new Error(`${message} The returned "model" must be static.`);
  }

  const config: {
    compaction?: DynamicSubagentAgentConfig["compaction"];
    description: string;
    limits?: AgentLimitsDefinition;
    model: DynamicSubagentModelReference;
    outputSchema?: JsonObject;
    reasoning?: AgentReasoningDefinition;
  } = {
    description: definition.description,
    model: normalizeModelReference({
      contextWindowTokens: definition.modelContextWindowTokens,
      model: definition.model,
      name: input.name,
      providerOptions: definition.modelOptions?.providerOptions,
    }),
  };

  if (definition.compaction !== undefined) {
    const compaction: {
      model?: DynamicSubagentModelReference;
      thresholdPercent?: number;
    } = {};
    if (definition.compaction.model !== undefined) {
      compaction.model = normalizeModelReference({
        contextWindowTokens: definition.compaction.modelContextWindowTokens,
        model: definition.compaction.model,
        name: input.name,
        providerOptions: definition.modelOptions?.providerOptions,
      });
    }
    if (definition.compaction.thresholdPercent !== undefined) {
      compaction.thresholdPercent = definition.compaction.thresholdPercent;
    }
    config.compaction = compaction;
  }
  if (definition.limits !== undefined) {
    config.limits = definition.limits;
  }
  if (definition.outputSchema !== undefined) {
    config.outputSchema = serializeOutputSchema(definition.outputSchema);
  }
  if (definition.reasoning !== undefined) {
    config.reasoning = definition.reasoning;
  }

  return config;
}

function normalizeModelReference(input: {
  readonly contextWindowTokens?: number;
  readonly model: PublicAgentStaticModelDefinition;
  readonly name: string;
  readonly providerOptions?: Record<string, JsonObject>;
}): DynamicSubagentModelReference {
  if (typeof input.model !== "string") {
    throw new Error(
      `Dynamic subagent "${input.name}" must return model IDs as strings so its agent config can cross durable workflow boundaries.`,
    );
  }

  const reference: {
    contextWindowTokens?: number;
    id: string;
    providerOptions?: Record<string, JsonObject>;
  } = { id: formatLanguageModelGatewayId(input.model) };
  if (input.contextWindowTokens !== undefined) {
    reference.contextWindowTokens = input.contextWindowTokens;
  }
  if (input.providerOptions !== undefined) {
    reference.providerOptions = Object.fromEntries(
      Object.entries(input.providerOptions).map(([provider, options]) => [
        provider,
        parseJsonObject(options),
      ]),
    );
  }
  return reference;
}
