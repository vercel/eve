import { defineTool, type ToolDefinition } from "#public/definitions/tool.js";
import {
  executeSleepTool,
  SLEEP_INPUT_SCHEMA,
  SLEEP_OUTPUT_SCHEMA,
  SLEEP_TOOL_DESCRIPTION,
  type SleepToolInput,
  type SleepToolOutput,
} from "#runtime/framework-tools/sleep.js";

export type { SleepToolInput, SleepToolOutput };

/**
 * Defines eve's opt-in durable `sleep` tool.
 *
 * Export it from `agent/tools/sleep.ts`:
 *
 * ```ts
 * import { sleep } from "eve/tools/sleep";
 *
 * export default sleep();
 * ```
 *
 * Calls pause the durable turn workflow rather than holding an application
 * runtime open with an in-process timer.
 */
export function sleep(): ToolDefinition<SleepToolInput, SleepToolOutput> {
  return defineTool({
    description: SLEEP_TOOL_DESCRIPTION,
    execute: executeSleepTool,
    inputSchema: SLEEP_INPUT_SCHEMA,
    outputSchema: SLEEP_OUTPUT_SCHEMA,
  });
}
