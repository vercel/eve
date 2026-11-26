import { hasErrorLineage, markErrorLineage } from "#shared/eve-error.js";

/**
 * Thrown when the client's own `fetch` rejects a valid request before any response arrives.
 * That is usually a network failure or an unreachable agent, but browsers report a redirect the
 * `redirect` policy refuses the same way. `cause` is the original rejection, and `message` is its
 * message. It extends `TypeError`, so `instanceof TypeError` checks keep working.
 *
 * Invalid requests, such as a `GET` with a body, throw the platform's `TypeError` instead. Aborts
 * are not wrapped: an aborted request still rejects with the signal's reason. Narrow with
 * `ClientNetworkError.is(error)`.
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
  if (isRefusedRedirect(error)) return error;
  return new ClientNetworkError(error);
}

export function isRefusedRedirect(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.cause instanceof Error &&
    error.cause.message === "unexpected redirect"
  );
}

export async function clientFetch(url: string | URL, init: RequestInit): Promise<Response> {
  assertValidRequest(url, init);
  try {
    return await fetch(url, init);
  } catch (error) {
    throw toClientNetworkError(error, init.signal);
  }
}

function assertValidRequest(url: string | URL, init: RequestInit): void {
  const resolvable = new URL(url, "http://localhost");
  new Request(resolvable, { ...init, body: init.body == null ? init.body : "" });
}
