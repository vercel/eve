import type { Dispatcher1Wrapper } from "undici";

import {
  assertPublicHostname,
  createPublicDispatcher,
  fetchWithDispatcher,
} from "#execution/public-destination.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const WEB_FETCH_DESTINATION_POLICY = { allowLoopback: false } as const;

/** Options for an SSRF-safe HTTPS request. */
interface PublicUrlRequestOptions {
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
  let url = parseHttpsUrl(urlText);

  for (let redirectCount = 0; ; redirectCount++) {
    const { dispatcher, response } = await requestOnce(url, options);

    try {
      const location = response.headers.get("location");

      if (
        location !== null &&
        REDIRECT_STATUSES.has(response.status) &&
        redirectCount < MAX_REDIRECTS
      ) {
        await cancelResponseBody(response);
        url = parseHttpsUrl(new URL(location, url).toString());
        continue;
      }

      return await consumeResponse(response, options.maxResponseSize);
    } finally {
      await dispatcher.close();
    }
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
  assertPublicHostname(url.hostname, WEB_FETCH_DESTINATION_POLICY);
  const dispatcher = await createPublicDispatcher(WEB_FETCH_DESTINATION_POLICY);

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

async function consumeResponse(response: Response, maxResponseSize: number): Promise<Response> {
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection will still be closed with its per-request dispatcher.
  }
}

function createResponseTooLargeError(maxResponseSize: number): Error {
  return new Error(`Response too large (exceeds ${maxResponseSize} bytes).`);
}
