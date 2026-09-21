import { defineTool } from "eve/tools";

export default defineTool({
  description: "Check that a removed destination cannot start replacement work.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const handle = ctx.registerAgent({
      key: "removed-destination",
      description: "Temporary destination.",
      target: { kind: "agent", name: "researcher" },
    });
    ctx.unregisterAgent(handle);
    try {
      await ctx.agent(handle, { message: "This must not run." });
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown or unregistered agent handle.")
        return { rejected: true };
      throw error;
    }
    throw new Error("A removed handle started replacement work.");
  },
});
