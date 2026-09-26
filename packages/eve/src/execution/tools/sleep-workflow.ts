import { sleep } from "#compiled/@workflow/core/index.js";

import type { SleepToolInput, SleepToolOutput } from "#execution/tools/sleep.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

/** Waits durably in a workflow dedicated to this tool call. */
export async function executeSleepTool(
  ctx: WorkflowToolContext<SleepToolInput, SleepToolOutput>,
): Promise<SleepToolOutput> {
  "use workflow";

  const { input } = await ctx.receive();
  await sleep(Math.ceil(input.seconds * 1_000));
  return { waitedSeconds: input.seconds };
}
