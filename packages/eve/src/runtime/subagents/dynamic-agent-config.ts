import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import type { ContextAccessor } from "#context/key.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import {
  isDynamicModelDefinition,
  type AgentLimitsDefinition,
  type AgentReasoningDefinition,
} from "#shared/agent-definition.js";
import type { JsonObject } from "#shared/json.js";
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

export type DynamicSubagentModelReference = RuntimeModelReference;

export async function normalizeDynamicSubagentAgentConfig(input: {
  readonly catalog?: RuntimeModelCatalog;
  readonly name: string;
  readonly state: ContextAccessor;
  readonly value: unknown;
}): Promise<DynamicSubagentAgentConfig> {
  const message = `Dynamic subagent "${input.name}" must return defineAgent(...), defineRemoteAgent(...), or null.`;
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
    model: await normalizeDurableModelSelection({
      catalog: input.catalog,
      name: input.name,
      selection: {
        model: definition.model,
        modelContextWindowTokens: definition.modelContextWindowTokens,
        modelOptions: definition.modelOptions,
      },
      state: input.state,
    }),
  };

  if (definition.compaction !== undefined) {
    const compaction: {
      model?: DynamicSubagentModelReference;
      thresholdPercent?: number;
    } = {};
    if (definition.compaction.model !== undefined) {
      compaction.model = await normalizeDurableModelSelection({
        catalog: input.catalog,
        name: input.name,
        selection: {
          model: definition.compaction.model,
          modelContextWindowTokens: definition.compaction.modelContextWindowTokens,
          modelOptions: definition.modelOptions,
        },
        state: input.state,
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

async function normalizeDurableModelSelection(input: {
  readonly catalog?: RuntimeModelCatalog;
  readonly name: string;
  readonly selection: Parameters<typeof resolveRuntimeModelSelection>[0]["selection"];
  readonly state: ContextAccessor;
}): Promise<DynamicSubagentModelReference> {
  const resolved = await resolveRuntimeModelSelection({
    catalog: input.catalog,
    selection: input.selection,
    state: input.state,
  });
  if (resolved.model !== undefined) {
    throw new Error(
      `Dynamic subagent "${input.name}" must return model IDs as strings so its agent config can cross durable workflow boundaries.`,
    );
  }
  return resolved.reference;
}
