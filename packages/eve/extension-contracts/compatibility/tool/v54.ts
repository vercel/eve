import { defineWorkflowTool, type WorkflowStepToolContext } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Return the session identity without accessing its sandbox.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    "use workflow";
    return await sessionIdentity(ctx);
  },
});

async function sessionIdentity(ctx: WorkflowStepToolContext) {
  "use step";
  return { sessionId: ctx.session.id };
}
