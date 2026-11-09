import { isBlockedDestinationHost } from "#shared/network-address.js";

/** Rejection for a destination that the {@link PublicDestinationPolicy} blocks. */
export class UnsafeDestinationError extends Error {
  constructor(
    message = "URL must not target localhost, private, link-local, or reserved IP addresses.",
  ) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}

/** Destination policy for a framework request to an untrusted URL. */
export interface PublicDestinationPolicy {
  /** Permits loopback destinations, such as callbacks between local development servers. */
  readonly allowLoopback: boolean;
}

/**
 * Rejects IP-literal and `localhost` hostnames the policy blocks. Socket
 * lookups never run for IP literals, so this check must precede the request.
 */
export function assertPublicHostname(hostname: string, policy: PublicDestinationPolicy): void {
  if (isBlockedDestinationHost(hostname, policy)) {
    throw new UnsafeDestinationError();
  }
}

/** Finds the policy rejection in an error, including one fetch wrapped from the socket lookup. */
export function findUnsafeDestinationError(error: unknown): UnsafeDestinationError | undefined {
  if (error instanceof UnsafeDestinationError) return error;
  return error instanceof Error && error.cause instanceof UnsafeDestinationError
    ? error.cause
    : undefined;
}

/**
 * Buffers a response from an untrusted host, rejecting a declared or streamed
 * body over `maxResponseSize` bytes, so its connection can close.
 */
export async function readBoundedResponse(
  response: Response,
  maxResponseSize: number,
): Promise<Response> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));

  if (declaredLength !== undefined && declaredLength > maxResponseSize) {
    await cancelResponseBody(response);
    throw new ResponseTooLargeError(maxResponseSize);
  }

  const body = await readBoundedBody(response, maxResponseSize);
  const responseBody = body.byteLength === 0 ? null : Uint8Array.from(body).buffer;

  return new Response(responseBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedBody(response: Response, maxResponseSize: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteLength += value.byteLength;
      if (byteLength > maxResponseSize) {
        await reader.cancel();
        throw new ResponseTooLargeError(maxResponseSize);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection will still be closed with its per-request dispatcher.
  }
}

export class ResponseTooLargeError extends Error {
  constructor(maxResponseSize: number) {
    super(`Response too large (exceeds ${maxResponseSize} bytes).`);
    this.name = "ResponseTooLargeError";
  }
}
