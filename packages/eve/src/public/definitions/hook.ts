import type { AuthoringEventType } from "#protocol/session-events/authoring.js";
import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { SessionView } from "../../protocol/session-projection/tables.js";
import type { SessionContext } from "./callback-context.js";
import type { ExactDefinition } from "./exact.js";

type ProtocolEvent<TType extends SessionEvent["type"]> = Extract<SessionEvent, { type: TType }>;

/**
 * Public event contract available to authored hooks: the session's facts, the progress records
 * a hook names explicitly, and the work events not yet moved to facts.
 *
 * The explicit map keeps hook compatibility independent from the internal protocol union: new
 * protocol events do not become extension hook events until eve exposes them here.
 */
export type HookEventMap = {
  readonly [T in AuthoringEventType]: ProtocolEvent<T>;
};

/** Event type discriminators available to authored hooks. */
export type HookEventType = keyof HookEventMap;

/** Authored hook event keys, including the wildcard subscriber. */
export type HookEventKey = HookEventType | "*";

/** Event received by a handler for one authored hook event key. */
export type HookEvent<TKey extends HookEventKey = HookEventType> = TKey extends HookEventType
  ? HookEventMap[TKey]
  : HookEventMap[HookEventType];

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
  /**
   * Where the event sits on the session's stream: the position of its line, and its index in
   * that line. Positions never change, so a hook can record how far it has handled the stream.
   */
  readonly position: FactPosition;
  /**
   * The session's tables as of the whole commit the event is in: what's open, and what the commit
   * settled. Read what changed from the event, and where things stand from the view.
   */
  readonly view: SessionView;
  /**
   * Cancels the running turn. The event's remaining subscribers still run,
   * then the turn settles like `session.cancel()`: `turn.settled` with
   * `outcome: "cancelled"` and `cause: {hook}`. Returns `void` because the turn stops after the hook
   * returns; call it before the handler's promise settles.
   *
   * eve logs a warning and ignores the call when the event cannot stop a
   * running turn (terminal facts, context changes, and work events a task's
   * run causes) or when it arrives after the event's hooks returned.
   */
  cancel(): void;
}

/**
 * Side-effect-only handler for one accepted runtime stream event.
 *
 * `TEvent` is one variant of {@link HookEvent}. {@link StreamEventHooks}
 * infers it from the event key. The typed event is the first argument, `ctx`
 * is the last.
 */
export type StreamEventHook<TEvent> = (event: TEvent, ctx: HookContext) => void | Promise<void>;

/**
 * Map of stream-event subscribers an authored hook file may declare.
 *
 * `*` matches every fact the session commits and runs after the typed handler for that event
 * (if any). Progress (streamed deltas and partial results) reaches a hook only through its own
 * key, such as `content.delta`.
 */
export type StreamEventHooks<TKey extends HookEventKey = HookEventKey> = {
  readonly [TKey_ in TKey]?: StreamEventHook<HookEvent<TKey_>>;
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
export interface HookDefinition<TKey extends HookEventKey = HookEventKey> {
  readonly events?: StreamEventHooks<TKey>;
}

type DefinedHookEventKeys<TDefinition extends HookDefinition> = Extract<
  keyof NonNullable<TDefinition["events"]>,
  HookEventKey
>;

/**
 * Identity-with-types helper. Returns the passed definition unchanged at
 * runtime while preserving its authored event keys behind the public
 * {@link HookDefinition} boundary and rejecting any key outside `events`.
 * Authors export
 * `defineHook({ events: { "session.started": (event, ctx) => { ... } } })`.
 */
export function defineHook<const T extends HookDefinition>(
  definition: ExactDefinition<T, HookDefinition>,
): HookDefinition<DefinedHookEventKeys<T>> {
  return definition;
}
