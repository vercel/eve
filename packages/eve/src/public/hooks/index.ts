/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * A hook is a map of event handlers: each runs once for each matching fact a commit carries. A
 * handler can cancel the running turn with `ctx.cancel`, or start the session's next turn
 * with `ctx.followUp` once a turn settles. External effects use
 * `ctx.occurrence.idempotencyKey` for services that support idempotency.
 */

export {
  type HookContext,
  type HookDefinition,
  type HookEvent,
  type HookEventKey,
  type HookEventMap,
  type HookEventType,
  type HookFollowUpEventKey,
  type HookFollowUpOptions,
  type HookFollowUpResult,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "#public/definitions/hook.js";
export type {
  DynamicKey,
  DynamicTurn,
  Memo,
  Occurrence,
  SessionFrame,
} from "#dynamic/definition.js";
