/**
 * Keeps definition helpers from accepting authored keys outside the public
 * definition shape while preserving literal inference for valid inputs.
 */
export type ExactDefinition<TInput, TShape> = TInput & {
  readonly [TKey in Exclude<keyof TInput, keyof TShape>]: never;
};
