import { z } from "#compiled/zod/index.js";

import { requestTurnSleep } from "#harness/turn-sleep.js";

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
 * Records a durable wait for the owning turn workflow to fulfill after the
 * current atomic step finishes.
 */
export function executeSleepTool(input: SleepToolInput): SleepToolOutput {
  requestTurnSleep(Math.ceil(input.seconds * 1_000));
  return { waitedSeconds: input.seconds };
}
