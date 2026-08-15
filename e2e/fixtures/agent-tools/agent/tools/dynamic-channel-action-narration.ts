import { isChannel } from "eve/channels";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import actionNarration from "../channels/action-narration";

/**
 * Exposes the channel-side observation on the next model step after a streamed
 * action request consumed pre-tool narration.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, actionNarration)) return null;

      const narration = ctx.channel.metadata.observedNarration;
      if (typeof narration !== "string" || narration.length === 0) return null;

      return {
        "read-channel-action-narration": defineTool({
          description:
            "Returns the narration the channel observed when the prior streamed action was requested. " +
            "Only call when the user asks to inspect that channel observation.",
          inputSchema: z.object({}),
          async execute() {
            return { narration };
          },
        }),
      };
    },
  },
});
