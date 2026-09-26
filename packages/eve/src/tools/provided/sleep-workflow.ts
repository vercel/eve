import { sleep } from "#compiled/@workflow/core/index.js";

import type { WorkflowToolContext } from "#public/tools/index.js";
import type { SleepToolInput, SleepToolOutput } from "#tools/provided/sleep.js";

/** Waits durably, and stops early when a new message arrives. */
export async function executeSleepTool(
  input: SleepToolInput,
  ctx: WorkflowToolContext,
): Promise<SleepToolOutput> {
  "use workflow";

  const interrupted = new Promise<"interrupted">((resolve) =>
    ctx.interruptSignal.addEventListener("abort", () => resolve("interrupted"), { once: true }),
  );
  const elapsed = sleep(Math.ceil(input.seconds * 1_000)).then(() => "elapsed" as const);
  const woke = await Promise.race([elapsed, interrupted]);
  return woke === "elapsed" ? { waitedSeconds: input.seconds } : { interrupted: true };
}
