import type { AuthoringEventType } from "#protocol/session-events/authoring.js";
import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { Memo, Occurrence, SessionFrame } from "../../dynamic/definition.js";
import type { SessionSendOptions } from "#channel/session.js";
import type { TurnPolicy } from "#channel/types.js";
import type { MessageContent } from "#shared/message-content.js";
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
 * How a hook's message treats the session's turns, set with `ctx.send()`'s `turnPolicy`:
 *
 * - `"yield"`, the default, only for hooks: the message starts the session's next turn once the
 *   running turn, or the turn the event belongs to, settles completed. Anything else that starts a
 *   turn first, a `session.cancel()`, a clear, or a reset drops it.
 * - `"steer"` and `"queue"`: the message is admitted like a person's message sent with that turn
 *   policy, at the running turn's next step boundary. It steers the running turn, or queues behind
 *   it, and starts a turn when none is running. It never steers a turn that waits on a person.
 */
export type HookTurnPolicy = "yield" | TurnPolicy;

/**
 * Options for `ctx.send()`: the shared send options' `context`, and `auth`, optional, plus
 * `turnPolicy`. Omitted, `auth` names no sender, and the message acts as the session's current
 * identity, so it may steer the running turn. A principal makes it act for them, and `null` sends
 * it with no caller, as with `session.send()`. There's no `idempotencyKey`: a hook sends at most
 * one message per event, which eve admits once.
 */
export type HookSendOptions = Pick<SessionSendOptions, "context"> &
  Partial<Pick<SessionSendOptions, "auth">> & {
    readonly turnPolicy?: HookTurnPolicy;
  };

/**
 * What `ctx.send()` did, decided when it's called. `queued` means eve recorded the message under
 * `deliveryId`, which its `delivery.admitted` names once the session admits it. A `"yield"`
 * message can still be dropped before then.
 */
export type HookSendResult =
  | { readonly queued: true; readonly deliveryId: string }
  | {
      readonly queued: false;
      /**
       * `already-queued`: this handler already sent a message for this event, or with `"yield"`,
       * this hook already queued one for the turn.
       * `not-completed`: with `"yield"`, the turn failed, or something other than this hook
       * cancelled it.
       * `auth-conflict`: with `"yield"`, another hook's message for the turn acts for someone
       * else.
       */
      readonly reason: "already-queued" | "not-completed" | "auth-conflict";
    };

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
  /**
   * Sends `message` into the session as a delivery whose source names this hook and the channel,
   * from any event. `turnPolicy` decides how it treats the session's turns; see
   * {@link HookTurnPolicy}. A handler sends at most one message per event. Unlike
   * `session.send()`, it returns synchronously with the delivery's id, and there's no receipt to
   * await: the session admits the message after the handler returns. The model is told a hook
   * sent it, and it never answers a pending question. Like other hook effects, it's lost if the
   * step is interrupted before it's saved. Throws after the handler has settled.
   */
  send(message: MessageContent, options?: HookSendOptions): HookSendResult;
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
 * model call. A handler can call `ctx.cancel`, `ctx.send`, or an external service. Pass `ctx.occurrence.idempotencyKey` to services that support idempotency. A retry
 * does not run handlers again for facts already published. A handler that throws during a turn fails the turn;
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
