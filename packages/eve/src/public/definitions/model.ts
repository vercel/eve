import {
  defineDynamic as defineDynamicBase,
  type DefineDynamic,
  type DynamicModelContext,
} from "#dynamic/definition.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";

export type {
  PublicAgentDynamicModelResult as DynamicModelResult,
  PublicAgentModelSelectionDefinition as ModelSelection,
} from "#shared/agent-definition.js";

/**
 * Chooses an agent's model, as its `model` field: a function of the session that returns the
 * model, or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. It runs before each
 * model call, first among dynamic values, so it can't read `ctx.model`. To decide with I/O, such
 * as a call to a router model, decide in a memo keyed by how long the decision holds.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { defineDynamic } from "eve/models";
 *
 * export default defineAgent({
 *   model: defineDynamic(async (ctx) =>
 *     (await ctx.messages()).some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
 *   ),
 * });
 * ```
 */
export const defineDynamic = defineDynamicBase as DefineDynamic<
  PublicAgentDynamicModelResult,
  DynamicModelContext
>;
