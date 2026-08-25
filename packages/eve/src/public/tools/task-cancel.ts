import {
  TASK_CANCEL_DESCRIPTION,
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/tasks.js";
import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";

/**
 * Framework `task_cancel` tool: requests cooperative cancellation of one or
 * more background tasks. It has no executor — the runtime-action dispatch
 * step executes it against durable session state.
 */
export default markHarnessOwnedToolDefinition({
  description: TASK_CANCEL_DESCRIPTION,
  inputSchema: TASK_CANCEL_INPUT_SCHEMA,
  outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
});
