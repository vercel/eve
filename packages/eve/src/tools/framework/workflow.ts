import {
  dynamicWorkflowInputSchema,
  MAX_DYNAMIC_WORKFLOW_MAX_SUBAGENTS,
} from "#execution/dynamic-workflow/schema.js";
import { dynamicWorkflow } from "#execution/dynamic-workflow/workflow.js";
import { dynamicWorkflowReference } from "#execution/dynamic-workflow/workflow-reference.js";
import { attachToolBehavior } from "#tools/behavior.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

const execute = Object.assign(dynamicWorkflow, dynamicWorkflowReference);

export interface DynamicWorkflowToolOptions {
  /** Maximum child-agent calls one generated program may make, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

/** Creates the opt-in `workflow` tool with an optional per-program child-call budget. */
export function workflow(options: DynamicWorkflowToolOptions = {}) {
  if (
    options.maxSubagents !== undefined &&
    (!Number.isSafeInteger(options.maxSubagents) ||
      options.maxSubagents <= 0 ||
      options.maxSubagents > MAX_DYNAMIC_WORKFLOW_MAX_SUBAGENTS)
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(MAX_DYNAMIC_WORKFLOW_MAX_SUBAGENTS)}.`,
    );
  }
  return attachToolBehavior(
    defineWorkflowTool({
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
