// Existing callbacks remain valid when the runtime supplies session.context.
import { defineDynamic, defineTool } from "#public/tools/index.js";
export default defineDynamic({
  events: {
    "session.started": (_, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineTool({
            description: "Read the active caller.",
            inputSchema: { type: "object", properties: {} },
            execute: (_, ctx) => ctx.session.auth.current?.principalId,
          }),
  },
});
