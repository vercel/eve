import { ambientPlatform } from "#context/app.js";
import {
  assertPublicHostname,
  cancelResponseBody,
  fetchPublicDestination,
  readBoundedResponse,
  type PublicDestinationFetch,
} from "#execution/public-destination.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const WEB_FETCH_DESTINATION_POLICY = { allowLoopback: false } as const;

interface PublicUrlRequestOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly maxResponseSize: number;
  readonly signal: AbortSignal;
}

export async function requestPublicUrl(
  urlText: string,
  options: PublicUrlRequestOptions,
): Promise<Response> {
  let url = parseHttpsUrl(urlText);

  for (let redirectCount = 0; ; redirectCount++) {
    const { close, response } = await requestOnce(url, options);

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
      await close();
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
): Promise<PublicDestinationFetch> {
  assertPublicHostname(url.hostname, WEB_FETCH_DESTINATION_POLICY);
  return await fetchPublicDestination(
    url,
    { headers: options.headers, redirect: "manual", signal: options.signal },
    WEB_FETCH_DESTINATION_POLICY,
    ambientPlatform()?.network,
  );
}
