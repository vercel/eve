import type { Next, Policy, PolicyContext } from "./policy.js";

/**
 * eve's own loop. A delivered structured value settles; results the model hasn't read call it
 * again, unless every call ended the turn; otherwise the turn settles with the step's prose, or
 * with none when a call ended it.
 */
export function nativeNext({ turn }: Pick<PolicyContext, "turn">): Next {
  const last = turn?.lastStep;
  if (last === undefined) return { model: {} };
  if (last.output !== undefined) return { settle: { output: last.output } };
  if (turn!.unread && !last.endsTurn) return { model: {} };
  return { settle: { output: last.endsTurn ? null : last.text } };
}

export const nativePolicy: Policy = (ctx) => ({ next: () => nativeNext(ctx) });
