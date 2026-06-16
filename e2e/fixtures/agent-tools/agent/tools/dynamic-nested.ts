import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const sessionId = ctx.session.id;
      const version = "v2";

      function buildTool(action: string) {
        const endpoint = `/${version}/${action}`;
        return defineTool({
          description:
            `Nested-helper smoke test: performs "${action}" via the ${version} API. ` +
            `Only call when the user explicitly asks to run the \`nested_${action}\` tool.`,
          inputSchema: z.object({ tag: z.string().optional() }),
          async execute(input) {
            return {
              action,
              endpoint,
              sessionId,
              source: "helper",
              tag: input.tag ?? null,
            };
          },
        });
      }

      const tier = "premium";

      return {
        nested_query: buildTool("query"),
        nested_status: defineTool({
          description:
            "Returns the tier resolved by the handler. " +
            "Only call when the user explicitly asks to run the `nested_status` tool.",
          inputSchema: z.object({}),
          async execute() {
            return { tier, version, source: "inline" };
          },
        }),
      };
    },
  },
});
