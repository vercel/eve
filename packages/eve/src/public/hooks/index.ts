/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks subscribe to runtime stream events (under `events:`).
 * See {@link defineHook} for the authoring shape and
 * {@link HookContext} for the runtime context every handler receives.
 */

export {
  type HookContext,
  type HookDefinition,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "../definitions/hook.js";
