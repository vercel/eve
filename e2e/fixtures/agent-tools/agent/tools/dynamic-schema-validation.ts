import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "session.started": () => ({
      schema_validate: defineTool({
        description:
          "Returns the validated value. Call only when explicitly asked for schema_validate.",
        inputSchema: z.object({ value: z.string().trim().min(1) }),
        execute: (input) => ({ value: input.value }),
      }),
    }),
  },
});
