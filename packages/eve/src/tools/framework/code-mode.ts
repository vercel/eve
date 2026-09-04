import { attachToolBehavior } from "#tools/behavior.js";
import { defineTool } from "#tools/definition.js";
import { codeModeWorkflow } from "#execution/code-mode/workflow.js";
import { z } from "#compiled/zod/index.js";
import { codeModeWorkflowReference } from "#execution/code-mode/workflow-reference.js";

export const codeMode = attachToolBehavior(
  defineTool({
    description: "Execute one JavaScript program over the effective tool catalog.",
    execute: codeModeWorkflow,
    inputSchema: z.strictObject({
      js: z.string().describe("Complete JavaScript program to execute over the available tools."),
    }),
  }),
  {
    availability: ["root-session"],
    handling: { kind: "workflow-tool", workflowId: codeModeWorkflowReference.workflowId },
  },
);

export default codeMode;
