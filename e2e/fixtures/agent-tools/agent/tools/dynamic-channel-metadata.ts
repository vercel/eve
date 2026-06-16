import { isChannel } from "eve/channels";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import metadataProvider from "../channels/metadata-provider.js";

/**
 * Smoke-test fixture: resolves a tool only when the session was started
 * via the `metadata-provider` channel. Verifies that
 * `DynamicResolveContext.channel.metadata` surfaces the channel's
 * `metadata(state)` projection and that `isChannel` narrows it.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, metadataProvider)) return null;

      const { topic, contextMessages } = ctx.channel.metadata;
      if (!topic) return null;

      return defineTool({
        description:
          "Returns channel metadata visible to this resolver. " +
          "Only call when the user asks to read channel context.",
        inputSchema: z.object({}),
        async execute() {
          return {
            channelKind: ctx.channel.kind ?? null,
            topic,
            contextMessages,
          };
        },
      });
    },
  },
});
