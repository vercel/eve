import { sleep } from "#compiled/@workflow/core/index.js";

import type { SleepToolInput, SleepToolOutput } from "#execution/tools/sleep.js";

/** Waits durably in a workflow dedicated to this tool call. */
export async function executeSleepTool(input: SleepToolInput): Promise<SleepToolOutput> {
  "use workflow";

  await sleep(Math.ceil(input.seconds * 1_000));
  return { waitedSeconds: input.seconds };
}
