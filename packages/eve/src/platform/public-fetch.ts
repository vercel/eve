import type { PublicDestinationPolicy } from "#execution/public-destination.js";
import { createPublicDispatcher, fetchWithDispatcher } from "#execution/public-dispatcher.js";

// Requests to untrusted URLs in Node: through an undici dispatcher whose socket lookup rejects a
// hostname when any resolved address is blocked, then connects to those exact results, so DNS
// can't change between validation and connection (`execution/public-dispatcher.ts`).
// `public-fetch.web.ts` is the twin for a browser, which resolves names itself; the package's
// `#platform/*` imports pick one by the `node` condition.

/**
 * Runs `run` with a `fetch` held to `policy`, and closes its connections when `run` settles, so
 * read a response's body inside it. Callers check the URL's hostname first
 * (`assertPublicHostname`): a socket lookup never runs for an IP literal.
 */
export async function withPublicFetch<T>(
  policy: PublicDestinationPolicy,
  run: (fetchPublic: (url: string | URL, init: RequestInit) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const dispatcher = await createPublicDispatcher(policy);
  try {
    return await run((url, init) => fetchWithDispatcher(url, { ...init, dispatcher }));
  } finally {
    await dispatcher.close();
  }
}
