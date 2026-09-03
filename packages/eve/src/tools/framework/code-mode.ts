import { attachToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";
import { codeModeWorkflow } from "#execution/code-mode/workflow.js";
import { codeModeInputSchema } from "#execution/code-mode/schema.js";
import { codeModeWorkflowReference } from "#execution/code-mode/workflow-reference.js";

export const codeMode = attachToolBehavior(
  defineTool({
    description: "Execute one JavaScript program over the effective tool catalog.",
    execute: codeModeWorkflow,
    inputSchema: codeModeInputSchema,
  }),
  {
    availability: ["root-session"],
    handling: { kind: "workflow-tool", workflowId: codeModeWorkflowReference.workflowId },
  },
);

export default codeMode;
