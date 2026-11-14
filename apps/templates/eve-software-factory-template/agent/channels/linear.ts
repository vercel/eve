import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { stampTrusted } from "../lib/trust.js";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * `onAgentSession` accepts created/prompted events only for an identified user
 * in LINEAR_WORKSPACE_ID, stamps repository-bound trust, and adds the
 * requester's name as session
 * context when Linear provides it, for attribution in progress notes and
 * reports.
 */
export default linearChannel({
  credentials: connectLinearCredentials(
    process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"
  ),
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    const workspace = process.env.LINEAR_WORKSPACE_ID;
    const auth = defaultLinearAuth(event);
    if (
      !workspace ||
      auth.attributes.organization_id !== workspace ||
      auth.subject === "unknown"
    ) {
      return null;
    }
    const requester = event.agentActivity?.user ?? event.agentSession.creator;
    const context: string[] = [];
    const requesterName = requester?.displayName ?? requester?.name;
    if (requesterName) {
      context.push(`The requesting user is ${requesterName}.`);
    }
    return { auth: stampTrusted(auth), context };
  },
});
