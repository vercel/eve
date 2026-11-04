import {
  assertPublicHostname,
  cancelResponseBody,
  readBoundedResponse,
} from "#execution/public-destination.js";
import { withPublicFetch } from "#platform/public-fetch.js";

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
    // Each hop gets its own connections, closed once its response is read or discarded.
    const next = await requestOnce(url, options, redirectCount < MAX_REDIRECTS);
    if (next.response !== undefined) return next.response;
    url = parseHttpsUrl(new URL(next.location, url).toString());
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

/** One hop: its bounded response, or where it redirects when a redirect may still follow. */
async function requestOnce(
  url: URL,
  options: PublicUrlRequestOptions,
  mayRedirect: boolean,
): Promise<
  | { readonly response: Response; readonly location?: undefined }
  | { readonly response?: undefined; readonly location: string }
> {
  assertPublicHostname(url.hostname, WEB_FETCH_DESTINATION_POLICY);
  return await withPublicFetch(WEB_FETCH_DESTINATION_POLICY, async (fetchPublic) => {
    const response = await fetchPublic(url, {
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
    });
    const location = response.headers.get("location");
    if (location !== null && REDIRECT_STATUSES.has(response.status) && mayRedirect) {
      await cancelResponseBody(response);
      return { location };
    }
    return { response: await readBoundedResponse(response, options.maxResponseSize) };
  });
}
