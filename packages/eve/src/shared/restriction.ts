export interface Restriction<D> {
  readonly open: D;
  readonly meet: (a: D, b: D) => D;
}

export type Policy<Q, D> = (question: Q) => D;

export function decide<Q, D>(
  law: Restriction<D>,
  policies: readonly Policy<Q, D>[],
  question: Q,
): D {
  return policies.reduce((decision, policy) => law.meet(decision, policy(question)), law.open);
}
