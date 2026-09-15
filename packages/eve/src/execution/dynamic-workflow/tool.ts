import {
  parseWorkflowProgramInput,
  serializeWorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface WorkflowProgramToolInput {
  readonly agents?: readonly JsonValue[];
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
      agents: readPinnedAgents(input.agents),
      continuationSecurity: { signingKey: "validation-placeholder" },
      js: input.js,
      maxSubagents: input.maxSubagents ?? 0,
    }),
  );
  return runJsProgram(parsed.js, ctx, {
    agents: parsed.agents,
    maxSubagents: parsed.maxSubagents,
  });
}

function readPinnedAgents(value: WorkflowProgramToolInput["agents"]): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("workflow trusted agent options are missing.");
  }
  return value.map((agent) => {
    if (typeof agent !== "string") {
      throw new TypeError("workflow trusted agent options are invalid.");
    }
    return agent;
  });
}
