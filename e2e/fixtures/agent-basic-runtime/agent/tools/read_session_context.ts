import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "session.started": (_, { session }) =>
      session.context.surface === "docs"
        ? defineTool({
            description: "Read the application context captured when this chat opened.",
            inputSchema: z.object({}),
            execute: (_, ctx) => JSON.stringify(ctx.session.context),
          })
        : null,
  },
});
