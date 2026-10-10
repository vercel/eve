/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks react to the session: handlers for the events each commit carries (under `events:`), or
 * `select` and `resolve`. Both may return intents, {@link cancel} and {@link compact}.
 */

export {
  cancel,
  compact,
  type CancelIntent,
  type CompactIntent,
  type HookContext,
  type HookDefinition,
  type HookEvent,
  type HookEventKey,
  type HookEventMap,
  type HookEventType,
  type HookIntent,
  type HookResolveContext,
  type HookResult,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "#public/definitions/hook.js";
export type { ReactionView, SelectContext } from "#dynamic/definition.js";
