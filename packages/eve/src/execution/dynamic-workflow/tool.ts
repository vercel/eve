import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface WorkflowProgramToolInput {
  readonly js: string;
  readonly maxSubagents?: number;
}

export async function runWorkflowProgram(
  input: WorkflowProgramToolInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  return runJsProgram(input.js, ctx, {
    maxSubagents: input.maxSubagents ?? 0,
  });
}

export async function runWorkflowProgramTask(
  input: WorkflowProgramToolInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return runWorkflowProgram(input, ctx);
}

export async function runWorkflowProgramExecute(
  input: WorkflowProgramToolInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return runWorkflowProgram(input, ctx);
}
