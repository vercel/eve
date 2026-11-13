import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Resend MCP connection for outbound email (digest sends, summaries, confirmations).
 *
 * @remarks
 * Auth is a static bearer token from `RESEND_API_KEY`, the same key the Resend
 * chat-sdk adapter uses. A static token works in every session, including the
 * weekly digest's cron run, which has no signed-in user: user-scoped Vercel
 * Connect cannot resolve there (`principal_required`) and the Resend connector
 * does not issue app-scoped tokens. The key is resolved per call and never
 * exposed to the model.
 */
export default defineMcpClientConnection({
  auth: {
    getToken: () =>
      Promise.resolve({ token: requireEnv("RESEND_API_KEY", "re_123") }),
  },
  description:
    "Resend MCP: Manage emails, templates, contacts, broadcasts, automations, and more end-to-end.",
  url: "https://mcp.resend.com/mcp",
});
