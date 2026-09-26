import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowTaskContext } from "#tools/workflow-definition.js";

export interface WorkflowProgramToolInput {
  readonly js: string;
  readonly maxSubagents?: number;
}

/** Static workflow executor used by the provided `workflow` tool. */
export async function runWorkflowProgramTask(
  input: WorkflowProgramToolInput,
  ctx: WorkflowTaskContext,
): Promise<JsonValue> {
  "use workflow";

  return runJsProgram(input.js, ctx, {
    maxSubagents: input.maxSubagents ?? 0,
  });
}
