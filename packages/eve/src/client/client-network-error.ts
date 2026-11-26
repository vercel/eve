import { hasErrorLineage, markErrorLineage } from "#shared/eve-error.js";

/**
 * Thrown when the client's own `fetch` rejects before any response arrives, such as when the
 * network is down or the agent is unreachable. `cause` is the original rejection, and `message`
 * is its message. It extends `TypeError`, so `instanceof TypeError` checks keep working.
 *
 * Aborts are not wrapped: an aborted request still rejects with the signal's reason, usually a
 * `DOMException` named `AbortError`. Narrow with `ClientNetworkError.is(error)`.
 */
export class ClientNetworkError extends TypeError {
  /** Stable class name that `is()` matches and the instance `name` reports. */
  static readonly errorName = "ClientNetworkError";
  /** Stable snake_case error code. */
  readonly code = "network_error";
  /** The original rejection from `fetch`. */
  declare readonly cause: TypeError;

  constructor(cause: TypeError) {
    super(cause.message, { cause });
    this.name = ClientNetworkError.errorName;
    markErrorLineage(this, [ClientNetworkError.errorName]);
  }

  /** Whether `error` is a `ClientNetworkError`, from any copy of eve. */
  static is(error: unknown): error is ClientNetworkError {
    return hasErrorLineage(error, ClientNetworkError.errorName);
  }
}

export function toClientNetworkError(
  error: unknown,
  signal: AbortSignal | null | undefined,
): unknown {
  if (signal?.aborted || !(error instanceof TypeError) || ClientNetworkError.is(error))
    return error;
  return new ClientNetworkError(error);
}

export async function clientFetch(url: string | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw toClientNetworkError(error, init.signal);
  }
}
