import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";
import { stampTrusted } from "#lib/trust.js";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * `onAgentSession` hook keeps the default created/prompted dispatch, stamps
 * the caller as trusted (only workspace members can open an Agent Session, so
 * membership is the gate here), and adds the requester's name as session
 * context when Linear provides it, for attribution in progress notes and
 * reports.
 */
export default linearChannel({
  credentials: connectLinearCredentials(process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent"),
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    const requester = event.agentActivity?.user ?? event.agentSession.creator;
    const context: string[] = [];
    const requesterName = requester?.displayName ?? requester?.name;
    if (requesterName) {
      context.push(`The requesting user is ${requesterName}.`);
    }
    return { auth: stampTrusted(defaultLinearAuth(event)), context };
  },
});
