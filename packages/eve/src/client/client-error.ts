import { EveError } from "#shared/eve-error.js";
import { isObject } from "#shared/guards.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";

/**
 * Codes eve's HTTP routes return. Custom auth and proxies can return others, and `http_error`
 * means the response carried no code.
 */
export type ClientErrorCode =
  | "unauthorized"
  | "forbidden"
  | "eve_production_auth_not_configured"
  | "session_stranded"
  | "session_expired"
  | "descendant_unavailable"
  | "cycle"
  | "unsupported"
  | "session_version_unsupported"
  | "invalid_stream_response"
  | "http_error"
  | (string & {});

/**
 * Error thrown when the eve server returns a non-successful HTTP response.
 * Narrow with `ClientError.is(error)`.
 */
export class ClientError extends EveError {
  static override readonly errorName: string = "ClientError";
  /** The response body's eve error code, or `http_error` when it has none. */
  declare readonly code: ClientErrorCode;
  /**
   * HTTP status code returned by the server.
   */
  readonly status: number;

  /**
   * Raw response body text.
   */
  readonly body: string;

  /**
   * Response headers, normalized to lowercase names.
   */
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, body: string, headers?: ConstructorParameters<typeof Headers>[0]) {
    const normalizedHeaders = Object.freeze(Object.fromEntries(new Headers(headers).entries()));
    const contentType = normalizedHeaders["content-type"]?.toLowerCase();
    const parsed = parseJsonObject(body);
    let message = body || `Server returned ${status}.`;
    if (typeof parsed?.error === "string") message = parsed.error;
    else if (parsed === undefined && contentType?.includes("text/html")) {
      message = `Server returned ${status} with an HTML response. Check the eve route and development server configuration.`;
    }

    super(typeof parsed?.code === "string" ? parsed.code : "http_error", message);
    this.status = status;
    this.body = body;
    this.headers = normalizedHeaders;
  }
}

/**
 * Thrown by `ClientSession.send()`, `respond()`, `clear()`, and live stream connections when the server
 * answers `409 session_stranded`: another eve version built the session's owner, so it can never
 * execute on that deployment and new input is not delivered. Call `end()` on the session, then
 * create a new one. `stream({ follow: false })` still reads recorded history.
 */
export class ClientSessionStrandedError extends ClientError {
  static override readonly errorName = "ClientSessionStrandedError";
  declare readonly code: "session_stranded";
  /** The eve version that built the session, when it recorded one. */
  readonly eveVersion: string | undefined;

  constructor(
    status: number,
    body: string,
    headers: ConstructorParameters<typeof Headers>[0] | undefined,
    details: { readonly eveVersion: string | undefined },
  ) {
    super(status, body, headers);
    this.eveVersion = details.eveVersion;
  }
}

/** Builds the most specific client error for a failed eve session request. */
export function createClientError(
  status: number,
  body: string,
  headers?: ConstructorParameters<typeof Headers>[0],
): ClientError | SessionNotActiveError {
  const parsed = status === 409 ? parseJsonObject(body) : undefined;
  if (parsed?.code === "session_not_active" || parsed?.code === "session_not_ready") {
    return new SessionNotActiveError({ retryable: parsed.code === "session_not_ready" });
  }
  if (parsed?.code !== "session_stranded") return new ClientError(status, body, headers);
  return new ClientSessionStrandedError(status, body, headers, {
    eveVersion: typeof parsed.eveVersion === "string" ? parsed.eveVersion : undefined,
  });
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
