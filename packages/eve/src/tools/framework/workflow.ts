import { dynamicWorkflowInputSchema } from "#execution/dynamic-workflow/schema.js";
import { dynamicWorkflow } from "#execution/dynamic-workflow/workflow.js";
import { dynamicWorkflowReference } from "#execution/dynamic-workflow/workflow-reference.js";
import { attachToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";

const execute = Object.assign(dynamicWorkflow, dynamicWorkflowReference);

export const workflow = attachToolBehavior(
  defineTool({
    description: "Run a durable JavaScript program that coordinates child agents.",
    execute,
    inputSchema: dynamicWorkflowInputSchema,
  }),
  {
    availability: ["root-session"],
    handling: { kind: "workflow-tool", workflowId: dynamicWorkflowReference.workflowId },
  },
);

export default workflow;
