import { defineWorkflowTool, runWorkflowProgram, type WorkflowToolDefinition } from "eve/tools";

const agents = ["ticket-triage", "ticket-review", "ticket-reproducer"] as const;

const runProgramTool: WorkflowToolDefinition<
  Record<string, unknown>,
  Awaited<ReturnType<typeof runWorkflowProgram>>
> = defineWorkflowTool({
  description:
    "Run a JavaScript function body that coordinates ticket-triage, ticket-review, and ticket-reproducer through ctx.agent(name, input), then return one JSON value.",
  inputSchema: {
    properties: { js: { type: "string" } },
    required: ["js"],
    type: "object",
  },
  async execute({ js }, ctx) {
    "use workflow";
    if (typeof js !== "string") throw new TypeError('run-program requires a "js" string.');
    return runWorkflowProgram(js, ctx, { agents, maxSubagents: 3 });
  },
});

export default runProgramTool;
