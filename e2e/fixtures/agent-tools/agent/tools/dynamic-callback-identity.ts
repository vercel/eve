import { isChannel } from "eve/channels";
import { defineDynamic, defineTool } from "eve/tools";
import metadataProvider from "../channels/metadata-provider";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, metadataProvider)) return null;
      const topic = ctx.channel.metadata.topic;
      if (topic === "callback-guarded") {
        return {
          callback_identity: defineTool({
            description:
              "Returns the guarded callback identity. Call when asked for callback_identity.",
            inputSchema: { type: "object", properties: {} },
            execute: () => ({ implementation: "guarded", topic }),
          }),
        };
      }
      if (topic === "callback-open") {
        return {
          callback_identity: defineTool({
            description:
              "Returns the open callback identity. Call when asked for callback_identity.",
            inputSchema: { type: "object", properties: {} },
            execute: () => ({ implementation: "open", topic }),
          }),
        };
      }
      return null;
    },
  },
});
