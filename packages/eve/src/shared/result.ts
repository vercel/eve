/** A typed success-or-failure value for expected, recoverable outcomes. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wraps a value as a successful {@link Result}. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps an error as a failed {@link Result}. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
