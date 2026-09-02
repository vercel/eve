import { defineTool, type ToolDefinition } from "#tools/definition.js";
import {
  executeSleepTool,
  SLEEP_INPUT_SCHEMA,
  SLEEP_OUTPUT_SCHEMA,
  SLEEP_TOOL_DESCRIPTION,
  type SleepToolInput,
  type SleepToolOutput,
} from "#execution/tools/sleep.js";

export type { SleepToolInput, SleepToolOutput };

/**
 * Defines the opt-in durable `sleep` tool.
 *
 * Export it from `agent/tools/sleep.ts`:
 *
 * ```ts
 * import { sleep } from "eve/tools/sleep";
 *
 * export default sleep();
 * ```
 *
 * Each call runs as a durable workflow, so the wait does not hold an
 * application runtime open.
 */
export function sleep(): ToolDefinition<SleepToolInput, SleepToolOutput> {
  return defineTool({
    description: SLEEP_TOOL_DESCRIPTION,
    execute: executeSleepTool,
    inputSchema: SLEEP_INPUT_SCHEMA,
    outputSchema: SLEEP_OUTPUT_SCHEMA,
  });
}
