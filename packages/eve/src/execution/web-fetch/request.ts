import type { Dispatcher1Wrapper } from "undici";

import {
  assertPublicHostname,
  cancelResponseBody,
  createPublicDispatcher,
  fetchWithDispatcher,
  readBoundedResponse,
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

      return await readBoundedResponse(response, options.maxResponseSize);
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
