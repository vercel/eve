import { requestTurnSleep } from "#harness/turn-sleep.js";
import type { SleepToolInput, SleepToolOutput } from "#public/tools/sleep/index.js";

/**
 * Records a durable wait for the owning turn workflow to fulfill after the
 * current atomic step finishes.
 */
export function executeSleepTool(input: SleepToolInput): SleepToolOutput {
  requestTurnSleep(Math.ceil(input.seconds * 1_000));
  return { waitedSeconds: input.seconds };
}
