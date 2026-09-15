import { defineWorkflowTool, runWorkflowProgram } from "eve/tools";

const agents = ["ticket-triage", "ticket-review", "ticket-reproducer"] as const;

export default defineWorkflowTool({
  description:
    "Run a JavaScript function body that coordinates ticket-triage, ticket-review, and ticket-reproducer through ctx.agent(name, input), then return one JSON value.",
  inputSchema: {
    properties: { js: { type: "string" } },
    required: ["js"],
    type: "object",
  },
  async execute({ js }, ctx) {
    "use workflow";
    return runWorkflowProgram(js, ctx, { agents, maxSubagents: 3 });
  },
});
