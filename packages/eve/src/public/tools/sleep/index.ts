import { z } from "#compiled/zod/index.js";

import { executeSleepTool } from "#execution/tools/sleep.js";
import { defineTool, type ToolDefinition } from "#public/definitions/tool.js";

const MAX_SLEEP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export const SLEEP_TOOL_DESCRIPTION =
  "Wait for a specified amount of time before continuing. Use this when a process or condition needs time to change before it is useful to check its progress or status again.";

export const SLEEP_INPUT_SCHEMA = z.strictObject({
  seconds: z.number().positive().max(MAX_SLEEP_SECONDS).describe("How long to wait, in seconds."),
});

export const SLEEP_OUTPUT_SCHEMA = z.strictObject({
  waitedSeconds: z.number().positive(),
});

export type SleepToolInput = z.infer<typeof SLEEP_INPUT_SCHEMA>;
export type SleepToolOutput = z.infer<typeof SLEEP_OUTPUT_SCHEMA>;

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
