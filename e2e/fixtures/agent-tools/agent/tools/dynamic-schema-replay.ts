import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

const runtimeInput = z.object({ value: z.string().trim().min(1) });

export default defineDynamic({
  events: {
    "session.started": () => ({
      normalize_dynamic: defineTool({
        description: "Call only when asked to normalize_dynamic for the schema replay regression.",
        inputSchema: z.object({ value: z.string().min(1) }),
        execute(input) {
          return runtimeInput.parse(input);
        },
      }),
    }),
    "turn.started": (_event, ctx) => {
      if (!JSON.stringify(ctx.messages).includes("schema replay regression")) return null;
      return {
        invalid_dynamic_schema: defineTool({
          description: "Must be rejected before the model sees it.",
          inputSchema: z.object({ value: z.string().trim().min(1).optional() }),
          execute(input) {
            return input;
          },
        }),
      };
    },
  },
});
