import type { HandleMessageStreamEvent } from "../../protocol/message.js";
import type { SessionContext } from "./callback-context.js";
import type { ExactDefinition } from "./exact.js";
import type { GenericHookDefinition, GenericStreamEventHooks } from "#shared/hook-definition.js";

/**
 * Every hook handler receives this context.
 *
 * Extends {@link SessionContext} with agent and channel metadata.
 * `ctx` is always the last argument.
 */
export interface HookContext extends SessionContext {
  readonly agent: {
    readonly name: string;
    readonly nodeId?: string;
  };
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
  };
}

/**
 * Side-effect-only handler for one accepted runtime stream event.
 *
 * `TEvent` is one variant of the runtime stream-event union (a member of
 * {@link HandleMessageStreamEvent}). {@link StreamEventHooks} infers `TEvent`
 * from the event key. The typed event is the first argument, `ctx` is the last.
 */
export type StreamEventHook<TEvent> = (event: TEvent, ctx: HookContext) => void | Promise<void>;

/**
 * Map of stream-event subscribers an authored hook file may declare.
 *
 * `*` matches every accepted runtime stream event and runs after the
 * typed handler for that event (if any).
 */
export type StreamEventHooks = GenericStreamEventHooks<HandleMessageStreamEvent, HookContext>;

/**
 * Public hook definition authored in `agent/hooks/*.ts`.
 *
 * Hook files declare stream-event subscribers (under `events:`) that
 * fire after eve has accepted and durably recorded each event.
 * Handlers are observe-only: they cannot inject model context. To
 * contribute runtime model messages, use `defineDynamic` +
 * `defineInstructions` in `agent/instructions/`.
 */
export type HookDefinition = GenericHookDefinition<HandleMessageStreamEvent, HookContext>;

/**
 * Identity-with-types helper. Returns the passed definition unchanged
 * (identity at runtime) while preserving literal inference and rejecting
 * any authored key outside `events` as a compile-time error. Authors export
 * `defineHook({ events: { "session.started": (event, ctx) => { ... } } })`
 * and receive a typed {@link HookDefinition}.
 */
export function defineHook<T extends HookDefinition>(
  definition: ExactDefinition<T, HookDefinition>,
): T {
  return definition;
}
