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
  readonly "agent.started": ProtocolEvent<"agent.started">;
  readonly "approval.candidate": ProtocolEvent<"approval.candidate">;
  readonly "approval.settled": ProtocolEvent<"approval.settled">;
  readonly "authorization.completed": ProtocolEvent<"authorization.completed">;
  readonly "authorization.required": ProtocolEvent<"authorization.required">;
  readonly "input.requested": ProtocolEvent<"input.requested">;
  readonly "input.resolved": ProtocolEvent<"input.resolved">;
  readonly "task.settled": ProtocolEvent<"task.settled">;
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
