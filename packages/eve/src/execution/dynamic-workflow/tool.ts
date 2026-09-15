import {
  parseWorkflowProgramInput,
  serializeWorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
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

  const parsed = parseWorkflowProgramInput(
    serializeWorkflowProgramInput({
      continuationSecurity: { signingKey: "validation-placeholder" },
      js: input.js,
      maxSubagents: input.maxSubagents ?? 0,
    }),
  );
  return runJsProgram(parsed.js, ctx, {
    maxSubagents: parsed.maxSubagents,
  });
}
