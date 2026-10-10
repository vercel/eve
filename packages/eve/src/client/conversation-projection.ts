import type { InputResponse } from "#shared/input.js";
import {
  copyView,
  emptySessionView,
  foldReceivedEvent,
} from "#protocol/session-projection/fold.js";
import { isFactType } from "#protocol/session-events/catalog.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * What a client reducer carries alongside its public state: the shared tables every eve reader
 * folds, and the answers this client sent that the stream hasn't settled yet.
 */
export interface ConversationLedger {
  readonly view: SessionView;
  /** By request id: answers this client sent, shown as responded until the stream settles them. */
  readonly responded: Readonly<Record<string, InputResponse>>;
}

const ledgerKey = Symbol("eve.conversationLedger");

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

/**
 * Folds one received event into a ledger, copying the tables first so earlier states keep
 * theirs. Events that change no table, such as progress and client events, return `ledger`.
 * An answer the server refused leaves its request answerable again.
 */
export function foldConversationLedger(
  ledger: ConversationLedger,
  event: { readonly type: string; readonly data?: unknown; readonly meta?: unknown },
): ConversationLedger {
  if (!isFactType(event.type)) return ledger;
  const view = copyView(ledger.view);
  foldReceivedEvent(view, event as Parameters<typeof foldReceivedEvent>[1]);
  const settled = settledRequest(view, event);
  if (settled === undefined || ledger.responded[settled] === undefined)
    return { responded: ledger.responded, view };
  const { [settled]: _settled, ...responded } = ledger.responded;
  return { responded, view };
}

/**
 * The request an event leaves without this client's answer pending: one that settled, or one
 * whose answers were all refused or never applied, which leaves it answerable again.
 */
function settledRequest(
  view: SessionView,
  event: { readonly type: string; readonly data?: unknown },
): string | undefined {
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
