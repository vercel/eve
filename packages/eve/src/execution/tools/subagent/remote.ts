import { defineTool } from "#tools/definition.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { executeSubagentTool } from "#execution/tools/subagent/local.js";

export function defineRemoteSubagent(input: {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}) {
  return defineTool({
    description: input.description,
    execution: "background",
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    execute: (toolInput, ctx, task) =>
      executeSubagentTool({ definition: input, kind: "remote", task, toolContext: ctx, toolInput }),
  });
}
