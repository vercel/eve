import { defineTool } from "eve/tools";

export default defineTool({
  description: "Register a destination and optionally delegate work to it.",
  inputSchema: {
    type: "object",
    properties: { delegate: { type: "boolean" } },
    required: ["delegate"],
    additionalProperties: false,
  },
  async execute({ delegate }: { delegate: boolean }, ctx) {
    const handle = ctx.registerAgent({
      key: "discovered-researcher",
      description: "Researcher selected for this request.",
      target: { kind: "agent", name: "researcher" },
    });
    if (delegate) return ctx.agent(handle, { message: "Reply with AUTO-ROUTER-RESEARCHER." });
    return { registered: true };
  },
});
