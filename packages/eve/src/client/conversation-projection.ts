import type { InputResponse } from "#shared/input.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { isFactType } from "#protocol/session-events/catalog.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * What a client reducer carries alongside its public state: the shared tables every eve reader
 * folds, and the answers this client sent that the stream hasn't settled yet.
 *
 * The tables fold in place, so a long session's reload costs each event only what it changes.
 * Every state a reducer derives from one replay shares them; a replay from the initial state
 * starts new ones. Earlier states keep their public fields, never re-read the tables.
 */
export interface ConversationLedger {
  readonly view: SessionView;
  /** By request id: answers this client sent, shown as responded until the stream settles them. */
  readonly responded: Readonly<Record<string, InputResponse>>;
}

const ledgerKey = Symbol("eve.conversationLedger");

/** The last event each view folded, so a reducer called twice with one event folds it once. */
const foldedThrough = new WeakMap<SessionView, { readonly line: number; readonly index: number }>();

export function emptyConversationLedger(): ConversationLedger {
  return { responded: {}, view: emptySessionView() };
}

/** Keep event-contract details off the public state shape; reducers carry this hidden state forward. */
export function conversationLedger(state: object): ConversationLedger {
  return (state as { [ledgerKey]?: ConversationLedger })[ledgerKey] ?? emptyConversationLedger();
}

/** The shared tables a reducer's state carries. */
export function conversationView(state: object): SessionView {
  return conversationLedger(state).view;
}

export function withConversationLedger<T extends object>(state: T, ledger: ConversationLedger): T {
  if ((state as { [ledgerKey]?: ConversationLedger })[ledgerKey] === ledger) return state;
  return Object.defineProperty({ ...state }, ledgerKey, { value: ledger });
}

interface ReceivedEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly meta?: { readonly position?: { readonly line: number; readonly index: number } };
}

/**
 * Folds one received event into a ledger's tables. `folded` says whether the tables changed:
 * progress and client events change none, and an event the tables already hold is skipped. An
 * answer the server refused leaves its request answerable again.
 */
export function foldConversationLedger(
  ledger: ConversationLedger,
  event: ReceivedEvent,
): { readonly ledger: ConversationLedger; readonly folded: boolean } {
  if (!isFactType(event.type)) return { folded: false, ledger };
  const position = event.meta?.position;
  const through = foldedThrough.get(ledger.view);
  if (
    position !== undefined &&
    through !== undefined &&
    (position.line < through.line ||
      (position.line === through.line && position.index <= through.index))
  )
    return { folded: false, ledger };
  foldReceivedEvent(ledger.view, event as Parameters<typeof foldReceivedEvent>[1]);
  if (position !== undefined) foldedThrough.set(ledger.view, position);
  const settled = settledRequest(ledger.view, event);
  if (settled === undefined || ledger.responded[settled] === undefined)
    return { folded: true, ledger };
  const { [settled]: _settled, ...responded } = ledger.responded;
  return { folded: true, ledger: { responded, view: ledger.view } };
}

/**
 * The request an event leaves without this client's answer pending: one that settled, or one
 * whose answers were all refused or never applied, which leaves it answerable again.
 */
function settledRequest(view: SessionView, event: ReceivedEvent): string | undefined {
  const data = event.data as { readonly interactionId?: string; readonly responseId?: string };
  if (event.type === "interaction.settled") return data.interactionId;
  if (event.type !== "response.settled" || data.responseId === undefined) return undefined;
  const settled = view.responses[data.responseId];
  if (settled === undefined || settled.outcome === "applied") return undefined;
  const pending = Object.values(view.responses).some(
    (response) => response.interactionId === settled.interactionId && response.status !== "settled",
  );
  return pending ? undefined : settled.interactionId;
}
