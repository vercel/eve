import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * `onAgentSession` hook keeps the default created/prompted dispatch and adds
 * the requester's name and email as session context when Linear provides
 * them, so requests like "email me a summary" go to the right address without
 * asking.
 */
export default linearChannel({
  credentials: connectLinearCredentials(
    process.env.LINEAR_CONNECTOR ?? "linear/kody-agent"
  ),
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    const requester = event.agentActivity?.user ?? event.agentSession.creator;
    const context: string[] = [];
    if (requester?.email) {
      context.push(
        `The requesting user is ${requester.displayName ?? requester.name ?? "unknown"} (${requester.email}). When they ask for something by email, send it to that address unless they name another.`
      );
    }
    return { auth: defaultLinearAuth(event), context };
  },
});
