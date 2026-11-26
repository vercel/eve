import { EveError } from "#shared/eve-error.js";

/** Options for {@link HttpError}. */
export interface HttpErrorOptions {
  /** Stable machine-readable `code` in the JSON body. Defaults to `"request_rejected"`. */
  readonly code?: string;
  /** Human-readable `error` in the JSON body. Defaults to `"The request was rejected."`. */
  readonly message?: string;
  /** Extra response headers, such as `retry-after`. */
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * Error that rejects a channel request with a chosen HTTP status. Throw it from a
 * `routeAuth` auth function or from `eveChannel({ onMessage })`, and eve answers with
 * {@link HttpError.response}: a `{ ok: false, code, error }` JSON body with
 * `cache-control: no-store`. Other thrown errors answer `500`.
 *
 * ```ts
 * throw new HttpError(402, { code: "payment_required", message: "Upgrade your plan." });
 * ```
 */
export class HttpError extends EveError {
  static override readonly errorName: string = "HttpError";

  /** HTTP status of {@link HttpError.response}, from `400` to `599`. */
  readonly status: number;
  readonly #headers: Headers;

  constructor(status: number, opts: HttpErrorOptions = {}) {
    super(opts.code ?? "request_rejected", opts.message ?? "The request was rejected.");
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`HttpError status must be an integer from 400 to 599, got ${status}.`);
    }
    this.status = status;
    this.#headers = new Headers(opts.headers);
    this.#headers.set("cache-control", "no-store");
  }

  /** A new response for this error on every read, so one error instance can be thrown again. */
  get response(): Response {
    return Response.json(
      { code: this.code, error: this.message, ok: false },
      { headers: new Headers(this.#headers), status: this.status },
    );
  }
}

/** Options for {@link TooManyRequestsError}. */
export interface TooManyRequestsErrorOptions extends Omit<HttpErrorOptions, "headers"> {
  /**
   * Seconds until the caller may retry, rounded up and sent as the `retry-after` header.
   * Must be finite.
   */
  readonly retryAfter?: number;
}

/**
 * {@link HttpError} with status `429` and code `"rate_limited"`, for a caller over a
 * rate limit or quota.
 *
 * ```ts
 * throw new TooManyRequestsError({ retryAfter: 60 });
 * ```
 */
export class TooManyRequestsError extends HttpError {
  static override readonly errorName = "TooManyRequestsError";

  constructor(opts: TooManyRequestsErrorOptions = {}) {
    super(429, {
      code: opts.code ?? "rate_limited",
      message: opts.message ?? "Too many requests. Try again later.",
      headers:
        opts.retryAfter === undefined
          ? undefined
          : { "retry-after": formatRetryAfter(opts.retryAfter) },
    });
  }
}

function formatRetryAfter(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    throw new RangeError(
      `TooManyRequestsError retryAfter must be a finite number, got ${seconds}.`,
    );
  }
  return String(Math.max(0, Math.ceil(seconds)));
}
