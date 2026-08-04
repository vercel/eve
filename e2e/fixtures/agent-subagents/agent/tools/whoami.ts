import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Reports the session principals as one deterministic marker string, so an
 * eval can grep a parent reply for exactly which identities a child session
 * ran under: the current (per-turn) principal, the initiator (session
 * origin) principal, and the receiver-stamped `eve:forwarded-by` audit
 * attribute a forwarded principal carries.
 */
export default defineTool({
  description:
    "Reports the current session principals as a single marker string. Only call this when explicitly asked to run the whoami tool.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { current, initiator } = ctx.session.auth;
    const forwardedBy = current?.attributes["eve:forwarded-by"] ?? "none";
    return {
      marker: `WHOAMI current=${formatPrincipal(current)} initiator=${formatPrincipal(initiator)} forwarded-by=${String(forwardedBy)}`,
    };
  },
});

function formatPrincipal(
  context: { readonly principalId: string; readonly principalType: string } | null,
): string {
  return context === null ? "none" : `${context.principalType}:${context.principalId}`;
}
