import {
  TASK_UPDATE_DESCRIPTION,
  TASK_UPDATE_INPUT_SCHEMA,
} from "#runtime/framework-tools/tasks.js";
import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";

/**
 * Framework `task_update` tool: reports what a delegated background task is
 * currently doing. It has no executor — the runtime-action dispatch step
 * executes it against durable session state.
 */
export default markHarnessOwnedToolDefinition({
  description: TASK_UPDATE_DESCRIPTION,
  inputSchema: TASK_UPDATE_INPUT_SCHEMA,
});
