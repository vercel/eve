// Epoch 97 of the tool capability: step helpers typed with its context still accept the workflow context.
import { defineWorkflowTool, type WorkflowStepToolContext } from "#public/tools/index.js";

async function readIssue(ctx: WorkflowStepToolContext, issue: string) {
  "use step";
  const { token } = await ctx.getToken({
    principalType: "app",
    getToken: async () => ({ token: "service-credential" }),
  });
  return { issue, authorized: token.length > 0, session: ctx.session.id };
}

export default defineWorkflowTool({
  description: "Read an issue from the issue service.",
  inputSchema: {
    type: "object",
    properties: { issue: { type: "string" } },
    required: ["issue"],
    additionalProperties: false,
  },
  async execute(input: { issue: string }, ctx) {
    "use workflow";
    return await readIssue(ctx, input.issue);
  },
});
