import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

import { acmeOAuth } from "../lib/acme-oauth.js";

/**
 * Two modes, both real Vercel Sandboxes with deny-by-default egress and an
 * interactive consent that parks the agent:
 *
 * - **No tunnel (default, run from your laptop):** the protected route is a
 *   real public API (`api.github.com`) with `credentialResolution: "eager"`.
 *   Opening the sandbox parks the agent on the consent; the callback is your
 *   local dev server. No inbound traffic needed.
 *
 * - **On-request 428 mode (requires a public origin):** set
 *   `EVE_DEMO_PUBLIC_URL` to this app's own public HTTPS origin (a Vercel
 *   deployment of this app — tunnels cannot pass the egress proxy's OIDC
 *   audience check). The first request fails fast with the proxy's 428 and
 *   demand resolves after the command exits.
 */
export const DEMO_PUBLIC_URL = readPublicUrl();
export const NO_TUNNEL_TARGET_URL = "https://api.github.com/zen";

console.log(
  DEMO_PUBLIC_URL === undefined
    ? `egress-demo: no-tunnel mode — interactive consent guards ${NO_TUNNEL_TARGET_URL}`
    : `egress-demo: on-request mode — egress proxy at ${DEMO_PUBLIC_URL.origin} ` +
        "(unset EVE_DEMO_PUBLIC_URL if this origin is stale; challenge URLs derive from it)",
);

const backend =
  DEMO_PUBLIC_URL === undefined
    ? vercel({
        networkPolicy: {
          allow: {
            "api.github.com": [
              {
                auth: acmeOAuth,
                transform: ({ token }) => [{ headers: { "x-egress-demo-grant": token } }],
              },
            ],
          },
        },
      })
    : vercel({
        authProxyBaseUrl: DEMO_PUBLIC_URL.origin,
        networkPolicy: {
          allow: {
            [DEMO_PUBLIC_URL.host]: [
              {
                auth: acmeOAuth,
                credentialResolution: "on-request",
                match: { path: { exact: "/acme/report" } },
                transform: ({ token }) => [{ headers: { authorization: `Bearer ${token}` } }],
              },
            ],
          },
        },
      });

export default defineSandbox({ backend });

function readPublicUrl(): URL | undefined {
  const raw =
    process.env.EVE_DEMO_PUBLIC_URL ??
    (process.env.VERCEL === "1" && (process.env.VERCEL_URL ?? "").length > 0
      ? `https://${process.env.VERCEL_URL}`
      : undefined);
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:") {
    throw new Error("egress-demo: EVE_DEMO_PUBLIC_URL must be a public HTTPS URL.");
  }
  return url;
}
