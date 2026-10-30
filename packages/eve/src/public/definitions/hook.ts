import type { AuthoringEventType } from "#protocol/session-events/authoring.js";
import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { Memo, Occurrence, SessionFrame } from "../../dynamic/definition.js";
import type { SessionSendOptions } from "#channel/session.js";
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
 * Which handlers may continue a turn with `ctx.continue()`, by event key. Total over every
 * key, so a new hook event doesn't compile until it chooses.
 */
export const HOOK_CONTINUE_KEYS = {
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

/** Event keys whose handlers receive `ctx.continue()`: `turn.settled`, and `*`. */
export type HookContinueEventKey = {
  [K in HookEventKey]: (typeof HOOK_CONTINUE_KEYS)[K] extends true ? K : never;
}[HookEventKey];

/**
 * Options for `ctx.continue()`: the shared send options' `context`, and `auth`, optional. Omitted,
 * `auth` names no sender, and the turn runs as the session's current identity. A principal makes
 * the turn act for them, and `null` runs it with no caller, as with `session.send()`. There's no
 * `idempotencyKey`: a turn has one continuation, which eve records with the step and admits once.
 */
export type HookContinueOptions = Pick<SessionSendOptions, "context"> &
  Partial<Pick<SessionSendOptions, "auth">>;

/**
 * What `ctx.continue()` did, decided when it's called. `queued` means eve recorded the message;
 * another turn that starts first, a cancel, a clear, or a reset still drops it.
 */
export type HookContinueResult =
  | { readonly queued: true }
  | {
      readonly queued: false;
      /**
       * `not-settled`: a `*` handler ran for an event other than `turn.settled`.
       * `not-completed`: the turn failed, or something other than this hook cancelled it.
       * `already-queued`: this hook already continued this turn.
       * `auth-conflict`: another hook's continuation of this turn acts for a different principal.
       */
      readonly reason: "not-settled" | "not-completed" | "already-queued" | "auth-conflict";
    };

/**
 * Every hook handler receives this context: the session as of the commit the event is in, the
 * handler's occurrence, and the ways a hook acts. Handlers for {@link HookContinueEventKey} also
 * receive {@link HookContinue.continue}.
 */
export type HookContext<TKey extends HookEventKey = HookEventKey> = HookBaseContext &
  ([TKey] extends [HookContinueEventKey] ? HookContinue : unknown);

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
export interface HookContinue {
  /**
   * Starts the session's next turn with `message` after a turn completes, or after a turn this
   * hook cancelled, to redirect it. The message is recorded now and admitted once the session is
   * idle, as a delivery whose source names this hook and the channel, and the model is told no
   * person wrote it. Hooks that continue the same turn share one next turn, each message its own
   * payload, in hook order. It yields: any other turn that starts first, a `session.cancel()`, a
   * clear, or a reset drops it, so a person's input always wins. Unlike `session.send()`, it returns synchronously and there's no
   * receipt: the delivery doesn't exist until the session admits it. Like other hook effects, it's
   * lost if the step is interrupted before it's saved. Throws after the handler has settled.
   */
  continue(message: MessageContent, options?: HookContinueOptions): HookContinueResult;
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
 * model call. A handler can call `ctx.cancel`, `ctx.continue` from `turn.settled`, or an external
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
