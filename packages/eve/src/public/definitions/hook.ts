import type { SessionEvent } from "../../protocol/session-event.js";
import type { FactPosition } from "../../protocol/session-events/envelope.js";
import type { SessionView } from "../../protocol/session-projection/tables.js";
import {
  defineResolver,
  type ReactionSelect,
  type ReactionView,
  type ResolveContext,
} from "../../dynamic/definition.js";
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

/** Stops the turn running when the hook resolves, once: it settles `cancelled`. */
export interface CancelIntent {
  readonly kind: typeof INTENT_KIND;
  readonly type: "cancel";
  readonly reason?: string;
}

/** Compacts the conversation before the next model call, once per entry. */
export interface CompactIntent {
  readonly kind: typeof INTENT_KIND;
  readonly type: "compact";
  readonly reason?: string;
}

export const INTENT_KIND = "eve:intent" as const;

/**
 * Asks eve to stop the turn that is running when the hook resolves. The turn settles `cancelled`,
 * like `session.cancel()`. The intent targets that turn: it stops it once, and never a later turn.
 */
export function cancel(reason?: string): CancelIntent {
  return reason === undefined
    ? { kind: INTENT_KIND, type: "cancel" }
    : { kind: INTENT_KIND, reason, type: "cancel" };
}

/**
 * Asks eve to compact the conversation before the next model call. Each entry compacts once: the
 * compaction that follows satisfies it, and eve records that, so returning it again changes
 * nothing. To compact again, return it under a new name in a map, such as one with a count:
 *
 * ```ts
 * resolve: (imports) => ({ [`import-${imports}`]: compact({ reason: "A new import landed." }) })
 * ```
 */
export function compact(options: { readonly reason?: string } = {}): CompactIntent {
  return options.reason === undefined
    ? { kind: INTENT_KIND, type: "compact" }
    : { kind: INTENT_KIND, reason: options.reason, type: "compact" };
}

/**
 * What a hook may return: nothing, one intent, several, or a map of named intents. A compact is
 * keyed by its name in the map (`default` outside one); a cancel by the turn it stops.
 */
export type HookResult =
  | HookIntent
  | readonly HookIntent[]
  | Readonly<Record<string, HookIntent | null | undefined>>
  | null
  | undefined
  | void;

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
 * What a hook's `select` reads. Hooks run before the session's capabilities each commit, so their
 * view holds no capability state, such as the model; select that from a capability instead.
 */
export type HookView = Omit<ReactionView, "model">;

/** A hook of `events` handlers: each runs once for each record a commit carries of its type. */
export interface EventHookDefinition<TKey extends HookEventKey = HookEventKey> {
  readonly events: StreamEventHooks<TKey>;
  readonly select?: never;
  readonly resolve?: never;
}

/**
 * A hook of `select` and `resolve`: `resolve` runs after each commit that changes what `select`
 * read, and returns the hook's intents. eve may run it again with the same selection, so keep
 * effects in `events` handlers.
 */
export interface ResolverHookDefinition<TSelected = unknown> {
  readonly select: ReactionSelect<TSelected, HookView>;
  readonly resolve: (
    selected: TSelected,
    ctx: HookResolveContext,
  ) => HookResult | Promise<HookResult>;
  readonly events?: never;
}

/**
 * Public hook definition authored in `agent/hooks/*.ts`: a reaction to the session, either
 * `events` handlers or `select` and `resolve`. Both run after eve has durably recorded the commit,
 * and both may return intents such as {@link cancel}.
 */
export type HookDefinition<TKey extends HookEventKey = HookEventKey, TSelected = unknown> =
  | EventHookDefinition<TKey>
  | ResolverHookDefinition<TSelected>;

/**
 * Defines a hook and returns it with its authored event keys, rejecting any key outside the
 * definition. Pass `events` handlers, or `select` and `resolve`, never both.
 *
 * ```ts
 * export default defineHook({
 *   events: { "turn.started": async (fact, ctx) => ((await allowed(ctx)) ? null : cancel()) },
 * });
 * ```
 */
export function defineHook<const T extends StreamEventHooks<HookEventKey>>(definition: {
  readonly events: ExactDefinition<T, StreamEventHooks<HookEventKey>>;
}): EventHookDefinition<NoInfer<Extract<keyof T, HookEventKey>>>;
export function defineHook<TSelected>(
  definition: ResolverHookDefinition<TSelected>,
): ResolverHookDefinition<TSelected>;
export function defineHook(definition: HookDefinition<HookEventKey, unknown>): HookDefinition {
  return defineResolver(definition as never, "defineHook") as unknown as HookDefinition;
}
