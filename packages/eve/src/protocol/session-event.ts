import type { WorkStreamEvent } from "#protocol/message.js";
import type { FactPosition } from "#protocol/session-events/envelope.js";
import type { Fact, Progress } from "#protocol/session-events/facts.js";

/**
 * The v27 facts producers write today: the conversation families. Tasks, interactions, responses,
 * and child links still ride as v26 work events.
 */
export type ConversationFact = Exclude<
  Fact,
  { readonly type: `${"task" | "interaction" | "response" | "child"}.${string}` }
>;

/** What a session publishes: v27 conversation facts and progress, and the v26 work events. */
export type SessionEvent = ConversationFact | Progress | WorkStreamEvent;

/** Where and when a reader read one event back. Never on the wire: readers attach it. */
export interface SessionEventMeta {
  readonly position: FactPosition;
  /** The time of the commit that holds it, or of the latest commit for a progress record. */
  readonly at: string;
  /** False while more known records remain in this line; readers stop only after the commit. */
  readonly endOfLine?: boolean;
}

/** One event as a reader reads it back. */
export type SessionStreamEvent = SessionEvent & { readonly meta: SessionEventMeta };
