import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import type { ContextAccessor } from "#context/key.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { getEffectiveModelSelection } from "#reactions/kinds/model.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import {
  isDynamicModelDefinition,
  type AgentLimitsDefinition,
  type AgentReasoningDefinition,
  type AgentToolExposure,
} from "#shared/agent-definition.js";

export interface DynamicSubagentAgentConfig {
  readonly description: string;
  /** Serialized into workflow input, so it can't carry the `sessionUsage` function. */
  readonly limits?: Pick<AgentLimitsDefinition, "sessionTimeoutMs">;
  readonly model: DynamicSubagentModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly tool?: AgentToolExposure;
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
    throw new Error(
      `${message} The "build" field cannot be selected at runtime. Declare packaging configuration such as build.externalDependencies on the root agent in agent/agent.ts.`,
    );
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
  if (definition.limits?.sessionUsage !== undefined) {
    throw new Error(
      `${message} The "limits.sessionUsage" field cannot be selected at runtime; the root agent's \`sessionUsage\` applies.`,
    );
  }

  const config: {
    description: string;
    limits?: DynamicSubagentAgentConfig["limits"];
    model: DynamicSubagentModelReference;
    reasoning?: AgentReasoningDefinition;
    tool?: AgentToolExposure;
  } = {
    description: definition.description,
    model: await normalizeDurableModelSelection({
      catalog: input.catalog,
      selection: {
        model: definition.model,
        modelContextWindowTokens:
          definition.modelContextWindowTokens ?? parentContextWindow(input.state, definition.model),
        modelOptions: definition.modelOptions,
      },
      state: input.state,
    }),
  };

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

/**
 * The parent's context window, for a child that runs the parent's own model: a subagent that
 * passes `view.model.id` along gets the metadata the parent's model already has, which a custom
 * model's id alone doesn't carry.
 */
function parentContextWindow(state: ContextAccessor, model: unknown): number | undefined {
  if (typeof model !== "string") return undefined;
  const parent = getEffectiveModelSelection(state)?.reference;
  return parent?.id === model ? parent.contextWindowTokens : undefined;
}
