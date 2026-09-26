import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface WorkflowProgramToolInput {
  readonly js: string;
  readonly maxSubagents?: number;
}

/** Static workflow executor used by the provided `workflow` tool. */
export async function executeWorkflowProgram(
  ctx: WorkflowToolContext<WorkflowProgramToolInput>,
): Promise<JsonValue> {
  "use workflow";

  const { abortSignal, callId, input } = await ctx.receive();
  return runJsProgram(
    input.js,
    { abortSignal, agent: ctx.agent, callId },
    { maxSubagents: input.maxSubagents ?? 0 },
  );
}
