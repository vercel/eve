import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface WorkflowProgramToolInput {
  readonly js: string;
  readonly maxSubagents?: number;
}

/** Static workflow executor used by the provided `workflow` tool. */
export async function executeWorkflowProgram(
  input: WorkflowProgramToolInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return runJsProgram(input.js, ctx, {
    maxSubagents: input.maxSubagents ?? 0,
  });
}
