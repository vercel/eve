import { defineRemoteAgent } from "eve";

/**
 * A remote agent pointing back at this same deployment, so one fixture plays
 * both sides of a `forwardPrincipal` hop: the create-session request leaves
 * over real HTTP carrying the parent turn's principal and lands on this
 * deployment's eve channel, whose `trustedForwarders` trusts exactly the
 * bearer this definition sends (see `agent/channels/eve.ts`).
 *
 * The URL resolves at runtime to the deployment's own address: `VERCEL_URL`
 * on Vercel, or the dev server's self-published origin locally.
 */
export default defineRemoteAgent({
  description:
    "Remote loopback agent. Call this only when the user explicitly asks to use the remote-loopback agent, passing the user's requested message through unchanged. Call it with only the `message` argument — never pass `outputSchema`.",
  url: () =>
    process.env.VERCEL_URL !== undefined && process.env.VERCEL_URL !== ""
      ? `https://${process.env.VERCEL_URL}`
      : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000"),
  headers: () => {
    const headers: Record<string, string> = {
      authorization: "Bearer e2e-principal-forwarding-router",
    };
    // Preview deployments behind Vercel deployment protection need the
    // bypass header on the self-call; harmless when protection is off.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass !== undefined && bypass !== "") {
      headers["x-vercel-protection-bypass"] = bypass;
    }
    return headers;
  },
  forwardPrincipal: true,
});
