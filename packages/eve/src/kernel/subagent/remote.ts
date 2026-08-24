import type { TaskExec, ToolContext } from "#public/definitions/tool.js";
import { executeSubagentTool } from "#kernel/subagent/local.js";

export function createRemoteSubagentExecute(input: {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}) {
  return (toolInput: unknown, ctx: ToolContext, task?: TaskExec) => {
    if (task === undefined) throw new Error("Background subagent execution requires task context.");
    return executeSubagentTool({
      definition: input,
      kind: "remote",
      task,
      toolContext: ctx,
      toolInput,
    });
  };
}
