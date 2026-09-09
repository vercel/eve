import { z } from "#compiled/zod/index.js";

export { executeSleepTool } from "#execution/tools/sleep-workflow.js";

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
