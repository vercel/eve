// Guards for observers: hooks and channels branch on open values with these, and fall back for
// values they don't know. Plain functions with no dependencies.

import { FACT_CATALOG, isFactType, isTerminalType, type Family } from "./catalog.js";
import type { Fact, FactOf } from "./facts.js";

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

/** True for a fact of a type this version knows. */
export function isKnownFact(value: { readonly type: string }): value is Fact {
  return isFactType(value.type);
}

/** True for a fact that ends its entity. */
export function isTerminal(fact: { readonly type: string }): fact is TerminalFact {
  return isTerminalType(fact.type);
}

/** The family a fact belongs to, or `undefined` for a type this version doesn't know. */
export function familyOf(fact: { readonly type: string }): Family | undefined {
  return isFactType(fact.type) ? FACT_CATALOG[fact.type].family : undefined;
}

/** True for a terminal fact that ended its entity normally. */
export function isCompleted(fact: { readonly type: string }): boolean {
  return isTerminal(fact) && "outcome" in fact.data && fact.data.outcome === "completed";
}

/** Matches terminal facts with one of the given outcomes. */
export function hasOutcome<TOutcome extends string>(...outcomes: readonly TOutcome[]) {
  return <TFact extends { readonly type: string }>(
    fact: TFact,
  ): fact is TFact & { readonly data: { readonly outcome: TOutcome } } =>
    isTerminal(fact) && (outcomes as readonly string[]).includes(fact.data.outcome);
}

/** Matches facts whose payload has one of the given kinds: content, capability, interaction, or context. */
export function hasKind<TKind extends string>(...kinds: readonly TKind[]) {
  return (fact: { readonly type: string; readonly data?: unknown }): boolean => {
    const kind = kindOf(fact);
    return kind !== undefined && (kinds as readonly string[]).includes(kind);
  };
}

/** A fact's open kind, wherever its family keeps it. */
export function kindOf(fact: {
  readonly type: string;
  readonly data?: unknown;
}): string | undefined {
  const data = fact.data as Readonly<Record<string, unknown>> | undefined;
  if (data === undefined || data === null) return undefined;
  if (typeof data.kind === "string") return data.kind;
  const nested = (data.capability ?? data.request) as Readonly<Record<string, unknown>> | undefined;
  return typeof nested?.kind === "string" ? nested.kind : undefined;
}

/** True for a fact about a compaction. */
export function isCompaction(fact: {
  readonly type: string;
  readonly data?: unknown;
}): fact is FactOf<"context.started" | "context.settled"> {
  return (
    (fact.type === "context.started" || fact.type === "context.settled") &&
    kindOf(fact) === "compaction"
  );
}
