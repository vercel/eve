/**
 * How the policies that answer one question combine. A policy can only restrict, so the answer
 * is the most restrictive one and the policies' order never matters. `meet` is associative,
 * commutative, and idempotent, and `open` restricts nothing.
 */
export interface Restriction<D> {
  readonly open: D;
  readonly meet: (a: D, b: D) => D;
}

/** Answers one question; the session acts on what every policy for it answered together. */
export type Policy<Q, D> = (question: Q) => D;

/** What `policies` answer together for `question`. */
export function decide<Q, D>(
  law: Restriction<D>,
  policies: readonly Policy<Q, D>[],
  question: Q,
): D {
  return policies.reduce((decision, policy) => law.meet(decision, policy(question)), law.open);
}
