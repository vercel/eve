import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { inspectTrace } from "../lib/trace-audit";

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      const requested = ctx.messages.some(
        (message) =>
          message.role === "user" &&
          (typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
          ).includes("inspect_trace"),
      );
      if (!requested) return null;
      return defineTool({
        description: "Check the trace relationships for this diagnostic step.",
        inputSchema: z.object({}),
        async execute(_input, toolContext) {
          return inspectTrace(toolContext.session.id);
        },
      });
    },
  },
});
