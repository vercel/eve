import { isChannel } from "eve/channels";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import actionNarration from "../channels/action-narration.js";

/**
 * Exposes the previous turn's channel-side observation only after a streamed
 * action request consumed pre-tool narration. The e2e eval drives a second
 * turn to read this value through the real dynamic-tool lifecycle.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
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
