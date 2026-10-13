import { defineDynamic as defineDynamicBase, type DefineDynamic } from "#dynamic/definition.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";

export type {
  PublicAgentDynamicModelResult as DynamicModelResult,
  PublicAgentModelSelectionDefinition as ModelSelection,
} from "#shared/agent-definition.js";

/**
 * Chooses an agent's model per session, as its `model` field. `select` reads what the choice
 * depends on, and `render` returns the model, or `{ model, reasoning?, modelContextWindowTokens?,
 * modelOptions? }`; eve renders again only when the selection changes. To decide with I/O, such
 * as a call to a router model, `record` decides once per selection and `render` uses its answer.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { defineDynamic } from "eve/models";
 *
 * export default defineAgent({
 *   model: defineDynamic({
 *     select: (view) => view.messages.some(hasImage),
 *     render: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
 *   }),
 * });
 * ```
 *
 * A provider object, such as `anthropic("...")`, is rendered: a process that didn't choose it
 * renders the same model from what the session recorded, without recording again.
 */
export const defineDynamic = defineDynamicBase as DefineDynamic<PublicAgentDynamicModelResult>;
