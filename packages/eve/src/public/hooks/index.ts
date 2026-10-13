/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks react to the session: handlers for the events each commit carries (under `events:`), or
 * `select` with `run`, which acts once for each new selection. Both may return intents,
 * {@link cancel} and {@link compact}, which act once per occurrence.
 */

export {
  cancel,
  compact,
  type CancelIntent,
  type CompactIntent,
  type HookContext,
  type EventHookDefinition,
  type HookDefinition,
  type HookEvent,
  type HookEventKey,
  type HookEventMap,
  type HookEventType,
  type HookIntent,
  type HookOccurrence,
  type HookResult,
  type HookRunContext,
  type HookView,
  type SelectHookDefinition,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "#public/definitions/hook.js";
export type { ReactionView, SelectContext } from "#dynamic/definition.js";

/** Named lifetimes for `select`: once per session, turn, or model call. */
export { once, perStep, perTurn } from "#dynamic/definition.js";
