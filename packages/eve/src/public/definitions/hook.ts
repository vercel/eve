import type { AuthoringEventType } from "#protocol/session-events/authoring.js";
import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { Memo, Occurrence, SessionFrame } from "../../dynamic/definition.js";
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
 * Every hook handler receives this context: the session as of the commit the event is in, the
 * handler's occurrence, and the ways a hook acts.
 */
export interface HookContext extends SessionContext, Omit<SessionFrame, "session"> {
  readonly session: SessionContext["session"] & SessionFrame["session"];
  readonly agent: {
    readonly name: string;
    readonly nodeId?: string;
  };
  /**
   * Where the event sits on the session's stream: the position of its line, and its index in
   * that line. Positions never change, so a hook can record how far it has handled the stream.
   */
  readonly position: FactPosition;
  /**
   * This handler's run for this fact. Its `idempotencyKey` is the fact's position in the stream,
   * so a retried step passes the same one.
   */
  readonly occurrence: Occurrence;
  /** Keeps what `fn` returns per key, as in a dynamic value; see {@link Memo}. */
  readonly memo: Memo;
  /**
   * Stops the running turn before its next model call; it settles `cancelled`, like
   * `session.cancel()`. Can also stop the turn while its input is being admitted. Acts once on
   * the turn, so asking again is safe; between turns without an incoming turn, it does nothing.
   * Throws after the handler has settled.
   */
  cancel(reason?: string): void;
}

/**
 * Handler for one accepted session event. `TEvent` is one variant of {@link HookEvent}, which
 * {@link StreamEventHooks} infers from the event key.
 */
export type StreamEventHook<TEvent> = (event: TEvent, ctx: HookContext) => void | Promise<void>;

/**
 * Map of event handlers an authored hook file may declare. `*` runs for every fact the session
 * commits, after the typed handler for that event (if any). Progress (streamed deltas and partial
 * results) reaches a hook only through its own key, such as `content.delta`.
 */
export type StreamEventHooks<TKey extends HookEventKey = HookEventKey> = {
  readonly [TKey_ in TKey]?: StreamEventHook<HookEvent<TKey_>>;
};

/**
 * Public hook definition authored in `agent/hooks/*.ts`: a map of event handlers, each called
 * once for each matching fact after eve has durably recorded the commit.
 */
export interface HookDefinition<TKey extends HookEventKey = HookEventKey> {
  readonly events: StreamEventHooks<TKey>;
}

type DefinedHookEventKeys<TDefinition extends HookDefinition> = Extract<
  keyof TDefinition["events"],
  HookEventKey
>;

/**
 * Defines a hook. Each handler runs once for each matching fact a commit carries, before the next
 * model call. A handler can call `ctx.cancel` or an external service. Pass
 * `ctx.occurrence.idempotencyKey` to services that support idempotency. A retry does not run
 * handlers again for facts already published. A handler that throws during a turn fails the turn;
 * catch optional errors.
 *
 * ```ts
 * export default defineHook({
 *   events: {
 *     async "model.settled"(_event, ctx) {
 *       if (spentUsd(ctx.view) <= 50) return;
 *       ctx.cancel("Session budget exceeded.");
 *     },
 *   },
 * });
 * ```
 */
export function defineHook<const T extends HookDefinition>(
  definition: ExactDefinition<T, HookDefinition>,
): HookDefinition<DefinedHookEventKeys<T>> {
  assertHookForm(definition, "defineHook()");
  return definition as HookDefinition<DefinedHookEventKeys<T>>;
}

/**
 * Throws unless `value` is a hook: an object with an `events` map and nothing else. The definer,
 * the compiler, and the runtime loader all use it.
 */
export function assertHookForm(value: unknown, subject: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${subject} takes an object with events handlers.`);
  }
  const { events, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest).filter((key) => key !== "kind");
  if (extra.length > 0) {
    throw new Error(
      `${subject} takes only events handlers; unknown key(s): ${extra.join(", ")}. A hook acts on a condition from a handler, such as "*", with ctx.cancel.`,
    );
  }
  if (typeof events !== "object" || events === null) {
    throw new Error(`${subject} requires events: an object of handlers keyed by event type.`);
  }
}
