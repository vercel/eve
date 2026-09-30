import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";

export async function dynamicTurnReplayGate(_input: unknown, ctx: WorkflowToolContext) {
  "use workflow";

  const answer = await ctx.ask({
    display: "confirmation",
    options: [
      { id: "approve", label: "Continue", style: "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Resume the turn-scoped dynamic tool check?",
  });
  return { approved: answer.status === "answered" && answer.optionId === "approve" };
}

const tool: WorkflowToolDefinition<
  Record<string, unknown>,
  { approved: boolean }
> = defineWorkflowTool({
  description:
    "Pause the dynamic turn replay check until the user approves. Only call for DYNAMIC-TURN-REPLAY-START.",
  inputSchema: { type: "object" },
  execute: dynamicTurnReplayGate,
});

export default tool;
