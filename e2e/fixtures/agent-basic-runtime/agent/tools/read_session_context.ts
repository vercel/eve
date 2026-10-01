import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "session.started": (_, { session }) =>
      session.context.surface === "docs"
        ? defineTool({
            description: "Read the application and turn context for this chat.",
            inputSchema: z.object({}),
            execute: (_, ctx) =>
              JSON.stringify({ session: ctx.session.context, turn: ctx.turn.context }),
          })
        : null,
  },
});
