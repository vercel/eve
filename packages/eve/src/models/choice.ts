import {
  type AgentModelOptionsDefinition,
  MODEL_CHOICE_KIND,
  type PublicAgentModelChoice,
  type PublicAgentModelChoicesDefinition,
  type PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";

/** A described model inside a `choice([...])` list. */
export interface ModelChoiceEntry {
  readonly model: PublicAgentStaticModelDefinition;
  /** Tells the caller when to pick this model. */
  readonly description?: string;
  /** Provider options for this model only, such as AI Gateway fallback models. */
  readonly modelOptions?: AgentModelOptionsDefinition;
}

/** A description, or a description with provider options, keyed by Gateway slug. */
export type ModelChoiceValue =
  | string
  | {
      readonly description?: string;
      readonly modelOptions?: AgentModelOptionsDefinition;
    };

export type ModelChoices =
  | readonly [string | ModelChoiceEntry, ...(string | ModelChoiceEntry)[]]
  | Readonly<Record<string, ModelChoiceValue>>;

const INVALID_CHOICES =
  "choice() expects a non-empty list of AI Gateway slugs or models, or an object mapping slugs to descriptions.";

/**
 * Lets the caller pick this subagent's model when it starts a child. The
 * first entry is the default. The caller sends the model's slug through the
 * subagent tool's `model` field or `ctx.agent()`.
 *
 * ```ts
 * model: choice({
 *   "openai/gpt-6-luna": "Routine lookups where speed matters",
 *   "openai/gpt-6-sol": "Hard reasoning and engineering questions",
 * })
 * ```
 */
export function choice(choices: ModelChoices): PublicAgentModelChoicesDefinition {
  const entries = Array.isArray(choices)
    ? choices.map(fromListEntry)
    : Object.entries(choices as Readonly<Record<string, ModelChoiceValue>>).map(fromMapEntry);
  const [first, ...rest] = entries;
  if (first === undefined) throw new Error(INVALID_CHOICES);
  return { kind: MODEL_CHOICE_KIND, choices: [first, ...rest] };
}

function fromListEntry(entry: unknown): PublicAgentModelChoice {
  if (typeof entry === "string") return { model: entry };
  if (typeof entry !== "object" || entry === null || !("model" in entry)) {
    throw new Error(`${INVALID_CHOICES} List objects must set "model".`);
  }
  return entry as PublicAgentModelChoice;
}

function fromMapEntry([model, value]: readonly [string, unknown]): PublicAgentModelChoice {
  if (typeof value === "string") return { model, description: value };
  if (typeof value !== "object" || value === null || "model" in value) {
    throw new Error(
      `${INVALID_CHOICES} The value for "${model}" must be a description or { description?, modelOptions? }; its key is the model.`,
    );
  }
  return { model, ...(value as Omit<PublicAgentModelChoice, "model">) };
}
