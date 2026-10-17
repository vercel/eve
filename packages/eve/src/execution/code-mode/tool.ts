import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { AgentCodeModeDefinition } from "#shared/agent-definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { defineJsonSchema, toInputSchema, UNSPECIFIED_INPUT_SCHEMA } from "#tools/schema.js";
import { executeProgramWorkflow } from "./workflow.js";

export const EXECUTE_TOOL_NAME = "eve__execute";
export const EXECUTE_WORKFLOW_NAME = "executeProgramWorkflow";
export interface ExecuteInput {
  readonly source: string;
  readonly timeoutMs?: number;
}

export function createExecuteTool(config: AgentCodeModeDefinition): HarnessToolDefinition {
  const language = config === true ? "js" : config.language;
  const definition = defineWorkflowTool({
    description: `Execute an isolated ${language === "js" ? "JavaScript async function body" : "Python program"}. ${language === "py" ? "Call await exact_name(input) using flat tool names discovered with eve__search. The last expression is the JSON result; print() captures logs. Clock, entropy and OS access are disabled." : "Call tools.<exact_name>(input) for tools discovered with eve__search."} Tool calls use their normal approval policies. Calls issued together run concurrently. Return a JSON value. Maximum 32 concurrent calls, 256 total calls, default 5-minute deadline.`,
    inputSchema: defineJsonSchema<ExecuteInput>({
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: {
          type: "string",
          description:
            language === "py"
              ? "Python source with top-level await and a final JSON-valued expression (not return)."
              : "JavaScript async function body with top-level await and return.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 300000,
          description: "Whole-program deadline, including approvals. Defaults to 300000 ms.",
        },
      },
    }),
    execute: executeProgramWorkflow,
  });
  return {
    description: definition.description,
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    execute: undefined,
    frameworkTool: true,
    name: EXECUTE_TOOL_NAME,
    workflowId:
      Reflect.get(executeProgramWorkflow, "workflowId") ?? "workflow//eve//executeProgramWorkflow",
    executeInput: (input) => ({ ...(input as ExecuteInput), language }),
  };
}
