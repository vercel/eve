import { defineRemoteAgent } from "eve";
import { type OutboundAuthFn, vercelOidc } from "eve/agents/auth";

/**
 * Self-referential remote agent: the fixture calls its own deployment so the
 * eval stays a single app while still exercising the full remote dispatch and
 * session-callback wire (create session, park, notification and termination
 * callbacks).
 *
 * Locally the eval CLI's dev server publishes its origin as
 * `WORKFLOW_LOCAL_BASE_URL`; on Vercel the deployment's own URL is
 * `VERCEL_URL`. Loopback callback hosts are explicitly allowed by the
 * framework's SSRF guard, so the local leg works unmodified.
 */
function selfBaseUrl(): string {
  const local = process.env.WORKFLOW_LOCAL_BASE_URL?.trim();
  if (local) return local;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  throw new Error("agent-remote-callbacks: cannot resolve the deployment's own base URL.");
}

const oidc = vercelOidc();

/** OIDC on Vercel (route auth accepts same-project tokens); anonymous over loopback locally. */
const selfAuth: OutboundAuthFn = async () => (process.env.VERCEL ? oidc() : { headers: {} });

export default defineRemoteAgent({
  url: () => selfBaseUrl(),
  description: "Delegate probe tasks to the remote probe agent. Pass the full task in the message.",
  auth: selfAuth,
});
