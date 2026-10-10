import type { ModelMessage } from "ai";

import type { ResolveContext } from "#dynamic/definition.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";

/**
 * How eve's own model resolvers, such as auto(), choose among fixed options. The slot records the
 * option a session chose, so a process that didn't choose it rebuilds the same model from the
 * option without choosing again. Not public: authored resolvers return the model itself.
 */
export interface ModelOptions {
  /**
   * Chooses an option for the selection, or `null` while there's nothing to choose from. It may
   * read the conversation as it stands, which an authored `resolve` can't: the slot records what
   * it chose, and `rebuild` restores that, so it never runs again for the same selection.
   */
  readonly choose: (
    selected: never,
    ctx: ResolveContext & { readonly messages: readonly ModelMessage[] },
  ) => Promise<string | null>;
  /** The model an option names, or `undefined` for one these options no longer have. */
  readonly option: (key: string) => PublicAgentDynamicModelResult | undefined;
}

const MODEL_OPTIONS = Symbol.for("eve.model-options");

export function withModelOptions<T extends object>(definition: T, options: ModelOptions): T {
  Object.defineProperty(definition, MODEL_OPTIONS, { value: options });
  return definition;
}

export function modelOptionsOf(definition: unknown): ModelOptions | undefined {
  return typeof definition === "object" && definition !== null
    ? (Reflect.get(definition, MODEL_OPTIONS) as ModelOptions | undefined)
    : undefined;
}
