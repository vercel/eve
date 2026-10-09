import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { FactPosition, Scope } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// Framework adapters that read the session's v27 facts register them here, by adapter kind.
// Authored and built-in channels observe the v26 events `execution/legacy-events.ts` translates
// each line into, so the authoring API stays as it was; only framework bridges, such as a child
// session's link to its parent, read facts.

/** What a fact handler knows beyond the adapter's context: where the fact sits, and the tables. */
export interface FactHandlerContext extends ChannelAdapterContext {
  readonly position: FactPosition;
  readonly scope?: Scope;
  /** The immutable snapshot of the fact's line, supplied by its publisher. */
  readonly view: SessionView;
}

type FactData<T extends SessionEvent["type"]> =
  Extract<SessionEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Handlers for the facts and progress records a framework adapter reads. */
export type FactHandlers = {
  readonly [K in SessionEvent["type"]]?: (
    data: FactData<K>,
    ctx: FactHandlerContext,
  ) => void | Promise<void>;
};

const handlersByKind = new Map<string, FactHandlers>();

/** Registers the fact handlers of a framework adapter, keyed by its stable kind. */
export function registerFactHandlers(kind: string, handlers: FactHandlers): void {
  handlersByKind.set(kind, handlers);
}

/** The fact handler a framework adapter registered for one event type, if any. */
export function factHandlerOf(
  adapter: ChannelAdapter,
  type: SessionEvent["type"],
): ((data: unknown, ctx: FactHandlerContext) => void | Promise<void>) | undefined {
  const handlers = handlersByKind.get(adapter.kind);
  const handler = handlers?.[type];
  return handler as ((data: unknown, ctx: FactHandlerContext) => void | Promise<void>) | undefined;
}
