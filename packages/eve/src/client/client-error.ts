import { isObject } from "#shared/guards.js";

/**
 * Error thrown when the eve server returns a non-successful HTTP response.
 */
export class ClientError extends Error {
  /** Stable eve error code when the response body provides one. */
  readonly code: string | undefined;
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

    super(message);
    this.name = "ClientError";
    this.code = typeof parsed?.code === "string" ? parsed.code : undefined;
    this.status = status;
    this.body = body;
    this.headers = normalizedHeaders;
  }
}

/**
 * Thrown by `ClientSession.send()`, `respond()`, `clear()`, and live stream connections when the server
 * answers `409 session_stranded`: another eve version built the session's owner, so it can never
 * execute on that deployment and new input is not delivered. Call `reset()` on the session, then
 * create a new one. `stream({ follow: false })` still reads recorded history.
 */
export class ClientSessionStrandedError extends ClientError {
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
    this.name = "ClientSessionStrandedError";
    this.eveVersion = details.eveVersion;
  }
}

/** Builds the most specific client error for a failed eve session request. */
export function createClientError(
  status: number,
  body: string,
  headers?: ConstructorParameters<typeof Headers>[0],
): ClientError {
  const parsed = status === 409 ? parseJsonObject(body) : undefined;
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
