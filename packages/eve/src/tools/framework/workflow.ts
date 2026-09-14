import { dynamicWorkflowInputSchema } from "#execution/dynamic-workflow/schema.js";
import { dynamicWorkflow } from "#execution/dynamic-workflow/workflow.js";
import { dynamicWorkflowReference } from "#execution/dynamic-workflow/workflow-reference.js";
import { attachToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";

const execute = Object.assign(dynamicWorkflow, dynamicWorkflowReference);

export interface DynamicWorkflowToolOptions {
  /** Maximum child-agent calls one generated program may make. Defaults to 100. */
  readonly maxSubagents?: number;
}

/** Creates the opt-in `workflow` tool with an optional per-program child-call budget. */
export function workflow(options: DynamicWorkflowToolOptions = {}) {
  if (
    options.maxSubagents !== undefined &&
    (!Number.isSafeInteger(options.maxSubagents) || options.maxSubagents <= 0)
  ) {
    throw new TypeError("workflow maxSubagents must be a positive integer.");
  }
  return attachToolBehavior(
    defineTool({
      description: "Run a durable JavaScript program that coordinates child agents.",
      execute,
      inputSchema: dynamicWorkflowInputSchema,
    }),
    {
      availability: ["root-session"],
      handling: {
        kind: "workflow-tool",
        maxSubagents: options.maxSubagents,
        workflowId: dynamicWorkflowReference.workflowId,
      },
    },
  );
}

export const defaultWorkflow = workflow();

export default defaultWorkflow;
