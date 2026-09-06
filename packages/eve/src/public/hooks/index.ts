/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks subscribe to runtime stream events (under `events:`).
 * See {@link defineHook} for the authoring shape and
 * {@link HookContext} for the runtime context every handler receives.
 */

export {
  type BeforeResponseReleaseHook,
  type HookContext,
  type HookDefinition,
  type HookEvent,
  type HookEventKey,
  type HookEventMap,
  type HookEventType,
  type StreamEventHook,
  type StreamEventHooks,
  type ResponseReleaseCandidate,
  type ResponseReleaseHistory,
  defineHook,
} from "#public/definitions/hook.js";
