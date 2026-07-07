type BaseEvent = { type: string };

/**
 * Side-effect-only handler for one accepted runtime stream event.
 *
 * `TEvent` is one variant of the runtime stream-event union.
 * {@link GenericStreamEventHooks} infers `TEvent` from the event key.
 */
export type GenericStreamEventHook<TEvent extends BaseEvent, TContext> = (
  event: TEvent,
  ctx: TContext,
) => void | Promise<void>;

/**
 * Map of stream-event subscribers an authored hook file may declare.
 *
 * `*` matches every accepted runtime stream event and runs after the
 * typed handler for that event (if any).
 */
export type GenericStreamEventHooks<TEvent extends BaseEvent, TContext> = {
  readonly "*"?: GenericStreamEventHook<TEvent, TContext>;
} & {
  readonly [K in TEvent["type"]]?: GenericStreamEventHook<Extract<TEvent, { type: K }>, TContext>;
};

/**
 * Public hook definition authored in `agent/hooks/*.ts`.
 *
 * Hook files declare stream-event subscribers (under `events:`) that
 * fire after eve has accepted and durably recorded each event.
 * Handlers are observe-only: they cannot inject model context. To
 * contribute runtime model messages, use `defineDynamic` +
 * `defineInstructions` in `agent/instructions/`.
 */
export interface GenericHookDefinition<TEvent extends BaseEvent, TContext> {
  readonly events?: GenericStreamEventHooks<TEvent, TContext>;
}
