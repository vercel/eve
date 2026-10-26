import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import type { Dispatcher1Wrapper } from "undici";

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

type DispatcherRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher: Dispatcher1Wrapper;
};

/**
 * Rejects IP-literal and `localhost` hostnames the policy blocks. Socket
 * lookups never run for IP literals, so this check must precede the request.
 */
export function assertPublicHostname(hostname: string, policy: PublicDestinationPolicy): void {
  if (isBlockedDestinationHost(hostname, policy)) {
    throw new UnsafeDestinationError();
  }
}

/**
 * Creates a dispatcher whose socket lookup rejects a hostname when any
 * resolved address is blocked, then connects using those exact results so DNS
 * cannot change between validation and connection.
 */
export async function createPublicDispatcher(
  policy: PublicDestinationPolicy,
): Promise<Dispatcher1Wrapper> {
  const { Agent, Dispatcher1Wrapper } = await import("undici");
  return new Dispatcher1Wrapper(new Agent({ connect: { lookup: createPublicLookup(policy) } }));
}

/** Finds the policy rejection in an error, including one fetch wrapped from the socket lookup. */
export function findUnsafeDestinationError(error: unknown): UnsafeDestinationError | undefined {
  if (error instanceof UnsafeDestinationError) return error;
  return error instanceof Error && error.cause instanceof UnsafeDestinationError
    ? error.cause
    : undefined;
}

export function fetchWithDispatcher(url: string | URL, init: DispatcherRequestInit) {
  // Node's fetch types describe its bundled undici version, while the wrapper
  // adapts the installed undici dispatcher to that runtime protocol.
  const fetchWithUndici = fetch as typeof fetch &
    ((input: string | URL, init: DispatcherRequestInit) => Promise<Response>);
  return fetchWithUndici(url, init);
}

function createPublicLookup(policy: PublicDestinationPolicy): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }

      if (addresses.some(({ address }) => isBlockedDestinationHost(address, policy))) {
        callback(new UnsafeDestinationError(), "", 0);
        return;
      }

      const matchingAddresses =
        lookupOptions.family === undefined || lookupOptions.family === 0
          ? addresses
          : addresses.filter(({ family }) => family === lookupOptions.family);

      if (matchingAddresses.length === 0) {
        const error = new Error(
          `Unable to resolve URL hostname "${hostname}" in the requested IP family.`,
        );
        Object.assign(error, { code: "ENOTFOUND" });
        callback(error, "", 0);
        return;
      }

      if (lookupOptions.all === true) {
        callback(null, matchingAddresses);
        return;
      }

      const selected = matchingAddresses[0]!;
      callback(null, selected.address, selected.family);
    });
  };
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
    throw createResponseTooLargeError(maxResponseSize);
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
        throw createResponseTooLargeError(maxResponseSize);
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

function createResponseTooLargeError(maxResponseSize: number): Error {
  return new Error(`Response too large (exceeds ${maxResponseSize} bytes).`);
}
