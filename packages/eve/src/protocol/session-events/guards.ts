// Guards for observers: hooks and channels branch on open values with these, and fall back for
// values they don't know. Plain functions with no dependencies.

import { isTerminalType } from "./catalog.js";
import type { FactOf } from "./facts.js";

type TerminalFact = FactOf<
  | "session.ended"
  | "delivery.settled"
  | "turn.settled"
  | "model.settled"
  | "call.settled"
  | "task.ended"
  | "interaction.settled"
  | "response.settled"
  | "context.settled"
>;

/** True for a fact that ends its entity. */
export function isTerminal(fact: { readonly type: string }): fact is TerminalFact {
  return isTerminalType(fact.type);
}

/** True for a terminal fact that ended its entity normally. */
export function isCompleted(fact: { readonly type: string }): boolean {
  return isTerminal(fact) && "outcome" in fact.data && fact.data.outcome === "completed";
}
