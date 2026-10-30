import { defineTool } from "eve/tools";
import { z } from "zod";

import target from "../channels/target";

/** Hands the conversation to the target channel, as an escalation tool would. */
export default defineTool({
  description: "Hand this conversation to the target channel.",
  inputSchema: z.strictObject({ sessionRef: z.string() }),
  async execute({ sessionRef }, ctx) {
    const delivery = await ctx.to(target, { sessionRef }).send("Alice's request, handed off.", {
      auth: ctx.session.auth.current,
      idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
    });
    return { sessionId: delivery.sessionId };
  },
});
