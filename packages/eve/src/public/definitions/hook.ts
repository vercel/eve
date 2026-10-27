import type { AuthoringEventType } from "#protocol/session-events/authoring.js";
import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { Memo, Occurrence, SessionFrame } from "../../dynamic/definition.js";
import type { SessionSendOptions } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
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
 * Which handlers may follow up a turn with `ctx.followUp()`, by event key. Total over every
 * key, so a new hook event doesn't compile until it chooses.
 */
export const HOOK_FOLLOW_UP_KEYS = {
  "*": true,
  "call.input": false,
  "call.progress": false,
  "call.requested": false,
  "call.settled": false,
  "call.started": false,
  "child.opened": false,
  "content.completed": false,
  "content.delta": false,
  "context.settled": false,
  "context.started": false,
  "delivery.admitted": false,
  "delivery.consumed": false,
  "delivery.settled": false,
  "interaction.opened": false,
  "interaction.settled": false,
  "model.requested": false,
  "model.retried": false,
  "model.settled": false,
  "model.started": false,
  "response.admitted": false,
  "response.settled": false,
  "response.submitted": false,
  "session.ended": false,
  "session.started": false,
  "task.ended": false,
  "task.started": false,
  "turn.paused": false,
  "turn.settled": true,
  "turn.started": false,
  "usage.recorded": false,
} as const satisfies Readonly<Record<HookEventKey, boolean>>;

/** Event keys whose handlers receive `ctx.followUp()`: `turn.settled`, and `*`. */
export type HookFollowUpEventKey = {
  [K in HookEventKey]: (typeof HOOK_FOLLOW_UP_KEYS)[K] extends true ? K : never;
}[HookEventKey];

/** Options for `ctx.followUp()`: the shared send options, with `auth` optional. */
export type HookFollowUpOptions = Pick<SessionSendOptions, "context" | "idempotencyKey"> & {
  /**
   * Who the message acts for. Omitted, the message names no sender, and the turn runs as the
   * session's current identity.
   */
  readonly auth?: SessionAuthContext | null;
};

/**
 * What `ctx.followUp()` did, decided when it's called. `queued` means eve recorded the message;
 * another turn that starts first, a cancel, or a reset still drops it.
 */
export type HookFollowUpResult =
  | { readonly queued: true }
  | {
      readonly queued: false;
      /**
       * `not-settled`: a `*` handler ran for an event other than `turn.settled`.
       * `not-completed`: the turn failed or was cancelled.
       * `already-queued`: this or another hook already followed up this turn.
       */
      readonly reason: "not-settled" | "not-completed" | "already-queued";
    };

/**
 * Every hook handler receives this context: the session as of the commit the event is in, the
 * handler's occurrence, and the ways a hook acts. Handlers for {@link HookFollowUpEventKey} also
 * receive {@link HookFollowUp.followUp}.
 */
export type HookContext<TKey extends HookEventKey = HookEventKey> = HookBaseContext &
  ([TKey] extends [HookFollowUpEventKey] ? HookFollowUp : unknown);

/** What every hook handler receives. */
export interface HookBaseContext extends SessionContext, Omit<SessionFrame, "session"> {
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

/** What `turn.settled` and `*` handlers receive besides {@link HookBaseContext}. */
export interface HookFollowUp {
  /**
   * Starts the session's next turn with `message` after a turn completes. The message is
   * recorded now and admitted once the session is idle, as a delivery whose source names this
   * hook and the channel. It yields: any other turn that starts first, a `session.cancel()`, or
   * a reset drops it, so a person's input always wins. Unlike `session.send()`, it returns
   * synchronously, at most one follow-up per turn is queued, and there's no receipt: the
   * delivery doesn't exist until the session admits it. Throws after the handler has settled.
   */
  followUp(message: MessageContent, options?: HookFollowUpOptions): HookFollowUpResult;
}

/**
 * Handler for one accepted session event. `TEvent` is one variant of {@link HookEvent}, which
 * {@link StreamEventHooks} infers from the event key.
 */
export type StreamEventHook<TEvent, TKey extends HookEventKey = HookEventKey> = (
  event: TEvent,
  ctx: HookContext<TKey>,
) => void | Promise<void>;

/**
 * Map of event handlers an authored hook file may declare. `*` runs for every fact the session
 * commits, after the typed handler for that event (if any). Progress (streamed deltas and partial
 * results) reaches a hook only through its own key, such as `content.delta`.
 */
export type StreamEventHooks<TKey extends HookEventKey = HookEventKey> = {
  readonly [TKey_ in TKey]?: StreamEventHook<HookEvent<TKey_>, TKey_>;
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
 * model call. A handler can call `ctx.cancel`, `ctx.followUp` from `turn.settled`, or an external
 * service. Pass `ctx.occurrence.idempotencyKey` to services that support idempotency. A retry
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
