import { defineDynamic, defineWorkflowTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () => ({
      summarize: defineWorkflowTool({
        description: "Delegate a trip summary to the existing research agent.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, ctx) {
          "use workflow";
          return await ctx.agent("research", { message: "Summarize Alice's trip options." });
        },
      }),
    }),
  },
});
