import type { HandleMessageStreamEvent } from "../../protocol/message.js";
import type { SessionContext } from "./callback-context.js";
import type { ExactDefinition } from "./exact.js";

type ProtocolEvent<TType extends HandleMessageStreamEvent["type"]> = Extract<
  HandleMessageStreamEvent,
  { type: TType }
>;

/**
 * Public event contract available to authored hooks.
 *
 * The explicit map keeps hook compatibility independent from the internal
 * protocol union: new protocol events do not become extension hook events
 * until eve exposes them here.
 */
export interface HookEventMap {
  readonly "action.result": ProtocolEvent<"action.result">;
  readonly "actions.requested": ProtocolEvent<"actions.requested">;
  readonly "authorization.completed": ProtocolEvent<"authorization.completed">;
  readonly "authorization.required": ProtocolEvent<"authorization.required">;
  readonly "compaction.completed": ProtocolEvent<"compaction.completed">;
  readonly "compaction.requested": ProtocolEvent<"compaction.requested">;
  readonly "input.requested": ProtocolEvent<"input.requested">;
  readonly "message.appended": ProtocolEvent<"message.appended">;
  readonly "message.completed": ProtocolEvent<"message.completed">;
  readonly "message.received": ProtocolEvent<"message.received">;
  readonly "reasoning.appended": ProtocolEvent<"reasoning.appended">;
  readonly "reasoning.completed": ProtocolEvent<"reasoning.completed">;
  readonly "result.completed": ProtocolEvent<"result.completed">;
  readonly "session.completed": ProtocolEvent<"session.completed">;
  readonly "session.failed": ProtocolEvent<"session.failed">;
  readonly "session.started": ProtocolEvent<"session.started">;
  readonly "session.waiting": ProtocolEvent<"session.waiting">;
  readonly "step.completed": ProtocolEvent<"step.completed">;
  readonly "step.failed": ProtocolEvent<"step.failed">;
  readonly "step.started": ProtocolEvent<"step.started">;
  readonly "subagent.called": ProtocolEvent<"subagent.called">;
  readonly "subagent.completed": ProtocolEvent<"subagent.completed">;
  readonly "subagent.event": ProtocolEvent<"subagent.event">;
  readonly "subagent.started": ProtocolEvent<"subagent.started">;
  readonly "turn.cancelled": ProtocolEvent<"turn.cancelled">;
  readonly "turn.completed": ProtocolEvent<"turn.completed">;
  readonly "turn.failed": ProtocolEvent<"turn.failed">;
  readonly "turn.started": ProtocolEvent<"turn.started">;
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
 * `*` matches every accepted runtime stream event and runs after the
 * typed handler for that event (if any).
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
