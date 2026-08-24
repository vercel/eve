import { defineTool } from "#public/definitions/tool.js";
import { TASK_UPDATE_INPUT_SCHEMA } from "#shared/task-tool.js";

/** Canonical PR 1 source definition; durable execution remains in the harness. */
export const taskUpdate = defineTool({
  description:
    "Briefly tell the parent agent what this background task is currently doing. Report activity, not preliminary findings or results.",
  inputSchema: TASK_UPDATE_INPUT_SCHEMA,
  execute() {
    throw new Error("task_update is handled by eve's durable dispatch step.");
  },
});

export default taskUpdate;
