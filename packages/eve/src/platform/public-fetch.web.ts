import type { withPublicFetch as NodeTwin } from "./public-fetch.js";

// Requests to untrusted URLs in a browser or Web Worker: the page's own `fetch`. A browser
// resolves names itself, so nothing here can pin DNS; callers still refuse IP-literal and
// `localhost` hosts first (`assertPublicHostname`), and what the page can reach is what its user
// can, behind the browser's CORS rules. `public-fetch.ts` is the Node twin.

export const withPublicFetch: typeof NodeTwin = async (_policy, run) =>
  await run((url, init) => fetch(url, init));
