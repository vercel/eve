import { isObject } from "#shared/guards.js";

/**
 * Error thrown when the eve server returns a non-successful HTTP response.
 */
export class ClientError extends Error {
  /**
   * HTTP status code returned by the server.
   */
  readonly status: number;

  /**
   * Raw response body text.
   */
  readonly body: string;

  constructor(status: number, body: string) {
    let message = body || `Server returned ${status}.`;
    try {
      const parsed: unknown = JSON.parse(body);
      if (isObject(parsed) && typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {}

    super(message);
    this.name = "ClientError";
    this.status = status;
    this.body = body;
  }
}
