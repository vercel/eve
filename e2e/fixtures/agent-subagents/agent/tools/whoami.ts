import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Reports the session principal as one deterministic marker string, so an
 * eval can grep a parent reply for exactly which identity a child session
 * ran under — including the receiver-stamped `eve:forwarded-by` audit
 * attribute a forwarded principal carries.
 */
export default defineTool({
  description:
    "Reports the current session principal as a single marker string. Only call this when explicitly asked to run the whoami tool.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = ctx.session.auth.current;
    const principal = current === null ? "none" : `${current.principalType}:${current.principalId}`;
    const forwardedBy = current?.attributes["eve:forwarded-by"] ?? "none";
    return {
      marker: `WHOAMI principal=${principal} forwarded-by=${String(forwardedBy)}`,
    };
  },
});
