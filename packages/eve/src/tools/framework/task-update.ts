import { defineTool } from "#tools/definition.js";
import { TASK_UPDATE_INPUT_SCHEMA } from "#tools/framework/task-contract.js";

/** The harness intercepts this tool before its durable dispatch step executes. */
export const taskUpdate = defineTool({
  description:
    "Briefly tell the parent agent what this background task is currently doing. Report activity, not preliminary findings or results.",
  inputSchema: TASK_UPDATE_INPUT_SCHEMA,
  execute() {
    throw new Error("task_update is handled by eve's durable dispatch step.");
  },
});

export default taskUpdate;
