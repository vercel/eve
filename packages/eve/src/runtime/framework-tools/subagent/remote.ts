import { defineTool } from "#public/definitions/tool.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#runtime/framework-tools/tasks.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { executeSubagentTool } from "#runtime/framework-tools/subagent/local.js";

export function defineRemoteSubagent(input: {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}) {
  return defineTool({
    description: input.description,
    execution: "background",
    inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    execute: (toolInput, ctx, task) =>
      executeSubagentTool({ definition: input, kind: "remote", task, toolContext: ctx, toolInput }),
  });
}
