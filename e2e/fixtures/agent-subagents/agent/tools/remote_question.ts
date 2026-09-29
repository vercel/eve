import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

async function execute(_input: Record<string, never>, ctx: WorkflowToolContext): Promise<string> {
  "use workflow";
  const answer = await ctx.ask({ prompt: "What is Alice's approval word?", allowFreeform: true });
  if (answer.status !== "answered") throw new Error("Remote question was not answered.");
  return `REMOTE-QUESTION-ANSWER=${answer.text}`;
}

const tool: WorkflowToolDefinition<Record<string, never>, string> = defineWorkflowTool({
  description: "Ask Alice for an approval word during a remote workflow call.",
  inputSchema: z.object({}),
  execute,
});
export default tool;
