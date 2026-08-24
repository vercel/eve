import { defineTool } from "#public/definitions/tool.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#shared/task-tool.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#shared/agent-tool.js";
import { executeSubagentTool } from "#execution/tools/subagent/local.js";

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
