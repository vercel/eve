import { readAgentModelSelection } from "#context/agent-model-selection.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import type { ContextAccessor } from "#context/key.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  DURABLE_PROVIDER_OBJECT_ERROR,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import {
  isDynamicModelDefinition,
  type AgentLimitsDefinition,
  type AgentReasoningDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";

export interface DynamicSubagentAgentConfig {
  readonly compaction?: {
    readonly model?: DynamicSubagentModelReference;
    readonly thresholdPercent?: number;
  };
  readonly description: string;
  readonly limits?: AgentLimitsDefinition;
  readonly model: DynamicSubagentModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly tool?: boolean;
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
  if (definition.defaultTools !== undefined) {
    throw new Error(`${message} The "defaultTools" field cannot be selected at runtime.`);
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
    reasoning?: AgentReasoningDefinition;
    tool?: boolean;
  } = {
    description: definition.description,
    model: await normalizeDynamicSubagentModel({
      catalog: input.catalog,
      definition,
      message,
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
  if (definition.reasoning !== undefined) {
    config.reasoning = definition.reasoning;
  }
  if (definition.tool !== undefined) {
    config.tool = definition.tool;
  }

  return config;
}

/**
 * A `ctx.model` selection reuses the parent's stored reference, including its
 * authored source and the node that holds it, so the subagent reaches the same
 * provider. Live step-scoped provider instances cannot be stored and fail like
 * any other non-serializable selection.
 */
async function normalizeDynamicSubagentModel(input: {
  readonly catalog?: RuntimeModelCatalog;
  readonly definition: ReturnType<typeof normalizeAgentDefinition>;
  readonly message: string;
  readonly state: ContextAccessor;
}): Promise<DynamicSubagentModelReference> {
  const { definition } = input;
  const inherited = readAgentModelSelection(definition.model);
  if (inherited === undefined) {
    return await normalizeDurableModelSelection({
      catalog: input.catalog,
      selection: {
        // Validated as a model id or provider object during selection.
        model: definition.model as PublicAgentStaticModelDefinition,
        modelContextWindowTokens: definition.modelContextWindowTokens,
        modelOptions: definition.modelOptions,
      },
      state: input.state,
    });
  }
  if (definition.modelContextWindowTokens !== undefined || definition.modelOptions !== undefined) {
    throw new Error(
      `${input.message} A "model" from ctx.model already carries its metadata; remove "modelContextWindowTokens" and "modelOptions".`,
    );
  }
  if (inherited.model !== undefined) {
    throw new Error(DURABLE_PROVIDER_OBJECT_ERROR);
  }
  // The subagent's own `reasoning` applies, as it does for a model id.
  const { reasoning: _reasoning, ...reference } = inherited.reference;
  return reference;
}

async function normalizeDurableModelSelection(input: {
  readonly catalog?: RuntimeModelCatalog;
  readonly selection: Parameters<typeof resolveRuntimeModelSelection>[0]["selection"];
  readonly state: ContextAccessor;
}): Promise<DynamicSubagentModelReference> {
  const resolved = await resolveRuntimeModelSelection({
    catalog: input.catalog,
    durability: "durable",
    selection: input.selection,
    state: input.state,
  });
  return resolved.reference;
}
