import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { SessionView } from "../../protocol/session-projection/tables.js";
import type { ReactionSelect, ResolveContext } from "../../dynamic/definition.js";
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
export interface HookEventMap {
  readonly "session.started": ProtocolEvent<"session.started">;
  readonly "session.ended": ProtocolEvent<"session.ended">;
  readonly "delivery.admitted": ProtocolEvent<"delivery.admitted">;
  readonly "delivery.consumed": ProtocolEvent<"delivery.consumed">;
  readonly "delivery.settled": ProtocolEvent<"delivery.settled">;
  readonly "turn.started": ProtocolEvent<"turn.started">;
  readonly "turn.paused": ProtocolEvent<"turn.paused">;
  readonly "turn.resumed": ProtocolEvent<"turn.resumed">;
  readonly "turn.settled": ProtocolEvent<"turn.settled">;
  readonly "model.requested": ProtocolEvent<"model.requested">;
  readonly "model.started": ProtocolEvent<"model.started">;
  readonly "model.settled": ProtocolEvent<"model.settled">;
  readonly "content.delta": ProtocolEvent<"content.delta">;
  readonly "content.completed": ProtocolEvent<"content.completed">;
  readonly "call.input": ProtocolEvent<"call.input">;
  readonly "call.requested": ProtocolEvent<"call.requested">;
  readonly "call.started": ProtocolEvent<"call.started">;
  readonly "call.progress": ProtocolEvent<"call.progress">;
  readonly "call.settled": ProtocolEvent<"call.settled">;
  readonly "usage.recorded": ProtocolEvent<"usage.recorded">;
  readonly "context.started": ProtocolEvent<"context.started">;
  readonly "context.settled": ProtocolEvent<"context.settled">;
  readonly "interaction.opened": ProtocolEvent<"interaction.opened">;
  readonly "interaction.settled": ProtocolEvent<"interaction.settled">;
  readonly "response.submitted": ProtocolEvent<"response.submitted">;
  readonly "response.admitted": ProtocolEvent<"response.admitted">;
  readonly "response.settled": ProtocolEvent<"response.settled">;
  readonly "child.opened": ProtocolEvent<"child.opened">;
  readonly "task.ended": ProtocolEvent<"task.ended">;
  readonly "task.started": ProtocolEvent<"task.started">;
}

/** Event type discriminators available to authored hooks. */
export type HookEventType = keyof HookEventMap;

/** Authored hook event keys, including the wildcard subscriber. */
export type HookEventKey = HookEventType | "*";

/** Event received by a handler for one authored hook event key. */
export type HookEvent<TKey extends HookEventKey = HookEventType> = TKey extends HookEventType
  ? HookEventMap[TKey]
  : HookEventMap[HookEventType];

/** A hook's request that the session act: see {@link cancel} and {@link compact}. */
export type HookIntent = CancelIntent | CompactIntent;

/** Stops the running turn: it settles `cancelled` with `cause: {hook}`. */
export interface CancelIntent {
  readonly kind: typeof INTENT_KIND;
  readonly type: "cancel";
  readonly reason?: string;
}

/** Compacts the conversation once per `key`, before the next model call. */
export interface CompactIntent {
  readonly kind: typeof INTENT_KIND;
  readonly type: "compact";
  readonly key: string;
}

export const INTENT_KIND = "eve:intent" as const;

/**
 * Asks eve to stop the running turn. Return it from a hook: the turn settles `cancelled`, like
 * `session.cancel()`, with `cause: {hook}`. eve ignores it when the commit that ran the hook can't
 * stop a turn, such as one that settles it.
 */
export function cancel(reason?: string): CancelIntent {
  return reason === undefined
    ? { kind: INTENT_KIND, type: "cancel" }
    : { kind: INTENT_KIND, reason, type: "cancel" };
}

/**
 * Asks eve to compact the conversation before the next model call. A key compacts once: the
 * compaction that follows satisfies it, so returning it again changes nothing. Use a new key, such
 * as one with a count in it, to compact again.
 */
export function compact(key = "hook"): CompactIntent {
  return { key, kind: INTENT_KIND, type: "compact" };
}

/** What a hook may return: nothing, one intent, or several. */
export type HookResult = HookIntent | readonly HookIntent[] | null | undefined | void;

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
}

/** What a hook's `resolve` receives besides its selection. */
export interface HookResolveContext extends ResolveContext, Omit<SessionContext, "session"> {
  readonly session: SessionContext["session"];
  readonly agent: HookContext["agent"];
}

/**
 * Handler for one accepted runtime stream event. It may return intents, such as
 * {@link cancel}.
 *
 * `TEvent` is one variant of {@link HookEvent}. {@link StreamEventHooks}
 * infers it from the event key. The typed event is the first argument, `ctx`
 * is the last.
 */
export type StreamEventHook<TEvent> = (
  event: TEvent,
  ctx: HookContext,
) => HookResult | Promise<HookResult>;

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
 * Public hook definition authored in `agent/hooks/*.ts`: a reaction to the session.
 *
 * Either `events`, handlers for the events a commit carries, or `select` and `resolve`: `select`
 * reads what the hook depends on from the session's view, and `resolve` runs right after each
 * commit that changes it. Both run after eve has durably recorded the commit, and both may return
 * intents such as {@link cancel}.
 */
export interface HookDefinition<TKey extends HookEventKey = HookEventKey, TSelected = unknown> {
  readonly events?: StreamEventHooks<TKey>;
  readonly select?: ReactionSelect<TSelected>;
  readonly resolve?: (
    selected: TSelected,
    ctx: HookResolveContext,
  ) => HookResult | Promise<HookResult>;
}

type DefinedHookEventKeys<TDefinition extends HookDefinition> = Extract<
  keyof NonNullable<TDefinition["events"]>,
  HookEventKey
>;

/**
 * Identity-with-types helper. Returns the passed definition unchanged at
 * runtime while preserving its authored event keys behind the public
 * {@link HookDefinition} boundary and rejecting any key outside the definition.
 *
 * ```ts
 * export default defineHook({
 *   events: { "turn.started": async (fact, ctx) => ((await allowed(ctx)) ? null : cancel()) },
 * });
 * ```
 */
export function defineHook<const T extends HookDefinition<HookEventKey, any>>(
  definition: ExactDefinition<T, HookDefinition<HookEventKey, any>>,
): HookDefinition<
  DefinedHookEventKeys<T>,
  T extends HookDefinition<HookEventKey, infer S> ? S : unknown
> {
  if (definition.events !== undefined && definition.resolve !== undefined) {
    throw new Error("defineHook() takes either events or select and resolve, not both.");
  }
  if (definition.select !== undefined && definition.resolve === undefined) {
    throw new Error("defineHook() with select also needs resolve.");
  }
  return definition as never;
}
