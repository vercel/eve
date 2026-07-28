import { lookup } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

import { Agent, Dispatcher1Wrapper } from "undici";

import { isLoopbackHostname, isPrivateOrReservedIpAddress } from "#shared/network-address.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UNSAFE_DESTINATION_ERROR =
  "URL must not target localhost, private, link-local, or reserved IP addresses.";

type DispatcherRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher: Dispatcher1Wrapper;
};

/** Options for an SSRF-safe HTTPS request. */
export interface PublicUrlRequestOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly maxResponseSize: number;
  readonly signal: AbortSignal;
}

/**
 * Requests an untrusted HTTPS URL while preventing access to non-public
 * network destinations.
 *
 * The socket lookup rejects the hostname if any resolved address is non-public
 * and connects using those exact results.
 */
export async function requestPublicUrl(
  urlText: string,
  options: PublicUrlRequestOptions,
): Promise<Response> {
  const url = parseHttpsUrl(urlText);
  const { dispatcher, response } = await requestOnce(url, options);

  try {
    const location = response.headers.get("location");

    if (location !== null && REDIRECT_STATUSES.has(response.status)) {
      await cancelResponseBody(response);
      const redirectUrl = parseHttpsUrl(new URL(location, url).toString());
      throw new Error(
        `Request redirected to ${redirectUrl.toString()}. Call web_fetch again with that URL.`,
      );
    }

    return await consumeResponse(response, options.maxResponseSize);
  } finally {
    await dispatcher.close();
  }
}

function parseHttpsUrl(urlText: string): URL {
  let url: URL;

  try {
    url = new URL(urlText);
  } catch {
    throw new Error("URL must be a valid absolute https:// URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("URL must start with https://");
  }

  return url;
}

async function requestOnce(
  url: URL,
  options: PublicUrlRequestOptions,
): Promise<{ readonly dispatcher: Dispatcher1Wrapper; readonly response: Response }> {
  assertPublicHostname(url.hostname);
  const agent = new Agent({
    connect: {
      lookup: createPublicLookup(),
    },
  });
  const dispatcher = new Dispatcher1Wrapper(agent);

  try {
    const response = await fetchWithDispatcher(url, {
      dispatcher,
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
    });
    return { dispatcher, response };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

function fetchWithDispatcher(url: URL, options: DispatcherRequestInit): Promise<Response> {
  // Node's fetch types describe its bundled undici version, while the wrapper
  // adapts the installed undici dispatcher to that runtime protocol.
  return fetch(url, options as RequestInit);
}

function assertPublicHostname(hostname: string): void {
  const normalizedHostname = hostname.replace(/^\[(.*)\]$/u, "$1");
  const family = isIP(normalizedHostname);

  if (family !== 0) {
    assertPublicAddress(normalizedHostname);
    return;
  }

  if (isLoopbackHostname(normalizedHostname)) {
    throw new Error(UNSAFE_DESTINATION_ERROR);
  }
}

function assertPublicAddress(address: string): void {
  if (isPrivateOrReservedIpAddress(address)) {
    throw new Error(UNSAFE_DESTINATION_ERROR);
  }
}

function createPublicLookup(): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }

      try {
        for (const { address } of addresses) {
          assertPublicAddress(address);
        }
      } catch (error) {
        callback(error as Error, "", 0);
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

async function consumeResponse(response: Response, maxResponseSize: number): Promise<Response> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));

  if (declaredLength !== undefined && declaredLength > maxResponseSize) {
    await cancelResponseBody(response);
    throw createResponseTooLargeError();
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
        throw createResponseTooLargeError();
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection will still be closed with its per-request dispatcher.
  }
}

function createResponseTooLargeError(): Error {
  return new Error("Response too large (exceeds 5 MB limit).");
}
