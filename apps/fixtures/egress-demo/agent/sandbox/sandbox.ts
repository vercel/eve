import { defaultBackend, defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

import { acmeOAuth } from "../lib/acme-oauth.js";

/**
 * The entire feature is one firewall rule: deny-by-default egress with a
 * single authenticated route resolved on request. The first sandbox
 * request to `/acme/report` fails fast with the proxy's 428, eve raises
 * the interactive authorization (parking the agent until consent), and
 * the firewall injects the credential once granted.
 *
 * `EVE_DEMO_PUBLIC_URL` must be a public HTTPS origin that reaches this
 * dev server (e.g. an ngrok/cloudflared tunnel to the eve dev port): the
 * Vercel firewall forwards blocked requests to it, and the consent
 * callback resumes the parked agent through it.
 */
const publicUrl = readPublicUrl();

const backend =
  publicUrl === undefined
    ? defaultBackend()
    : vercel({
        authProxyBaseUrl: publicUrl.origin,
        networkPolicy: {
          allow: {
            [publicUrl.host]: [
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
  const raw = process.env.EVE_DEMO_PUBLIC_URL;
  if (raw === undefined || raw.trim().length === 0) {
    console.warn(
      "egress-demo: EVE_DEMO_PUBLIC_URL is not set; falling back to the default local " +
        "sandbox without on-request egress auth. Start a tunnel to the eve dev port and " +
        "set EVE_DEMO_PUBLIC_URL=https://<tunnel-host> to run the full demo.",
    );
    return undefined;
  }
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:") {
    throw new Error("egress-demo: EVE_DEMO_PUBLIC_URL must be a public HTTPS URL.");
  }
  return url;
}
