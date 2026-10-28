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
 * How a hook's message treats the session's turns: `session.send()`'s turn policies, plus
 * `"yield"`, only for hooks.
 *
 * - `"steer"` and `"queue"`: admitted like a person's message with that policy, at the running
 *   turn's next step boundary. It steers the running turn or queues behind it, and starts a turn
 *   when none runs.
 * - `"yield"`: queued, but it gives way. It's admitted only once nothing else waits, and dropped
 *   if any other turn starts first, such as a person's message. A goal loop uses it so a person's
 *   message always wins.
 */
export type HookTurnPolicy = TurnPolicy | "yield";

/**
 * Options for `ctx.send()`: the shared send options' `auth` and `context`, as `session.send()`
 * takes them, and a {@link HookTurnPolicy} that defaults to `"steer"`, as for `session.send()`.
 *
 * `auth` is required and names who the message acts for: pass `ctx.session.auth.current` to act
 * as the session's current identity, a principal to act for them, or `null` for no caller. The
 * message's `delivery.admitted` records that principal, and its source names the hook.
 */
export type HookSendOptions = Pick<SessionSendOptions, "auth" | "context"> & {
  readonly turnPolicy?: HookTurnPolicy;
};

/**
 * What `ctx.send()` did, decided when it's called. `recorded` means eve recorded the message under
 * `deliveryId`; it doesn't mean the message ran. A person's cancel, clear, or reset can still drop
 * it, and so can another turn starting first, for `"yield"`. The session's `delivery.admitted` for
 * `deliveryId` confirms it took the message, and `delivery.consumed` that a turn read it.
 * `cancelled`: a person cancelled the session's latest turn, so hooks can't start another until a
 * new turn starts.
 */
export type HookSendResult =
  | { readonly recorded: true; readonly deliveryId: string }
  | { readonly recorded: false; readonly reason: "cancelled" };

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
   * Sends `message` into the session from any event, as `options.turnPolicy` says; see
   * {@link HookTurnPolicy}. It never steers a turn that waits on its person, and a person's cancel,
   * clear, or reset drops it: a person can always stop a hook's loop. Unlike `session.send()`, it
   * returns synchronously with the delivery's id, and there's no receipt to await: the session
   * admits the message after the handler returns. The model is told it was sent automatically, not
   * by a person, and it never answers a pending question. Like other hook effects, it's lost if
   * the step is interrupted before it's saved. Throws after the handler has settled.
   */
  send(message: MessageContent, options: HookSendOptions): HookSendResult;
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
