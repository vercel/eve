import {
  defineDynamic as defineDynamicBase,
  type DynamicDefinition,
  type DynamicSentinel,
} from "#dynamic/definition.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";

export type {
  PublicAgentDynamicModelResult as DynamicModelResult,
  PublicAgentModelSelectionDefinition as ModelSelection,
} from "#shared/agent-definition.js";

/**
 * Chooses an agent's model per session, as its `model` field. `select` reads what the choice
 * depends on, and `resolve` returns the model, or `{ model, reasoning?, modelContextWindowTokens?,
 * modelOptions? }`; eve calls it again only when the selection changes.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { defineDynamic } from "eve/models";
 *
 * export default defineAgent({
 *   model: defineDynamic({
 *     select: (view) => view.messages.some(hasImage),
 *     resolve: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
 *   }),
 * });
 * ```
 *
 * A model `resolve` returns as a gateway id is recorded with the session. A provider object, such
 * as `anthropic("...")`, is code: a process that didn't choose it calls `resolve` again with the
 * recorded selection, and a different model there fails the model call rather than switching.
 */
export function defineDynamic<TSelected = null>(
  definition: DynamicDefinition<TSelected, PublicAgentDynamicModelResult>,
): DynamicSentinel<PublicAgentDynamicModelResult, TSelected> {
  return defineDynamicBase(definition);
}
