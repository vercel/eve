import { sleep } from "#compiled/@workflow/core/index.js";

import { migrateSessionTimeoutWorkflowInput } from "#execution/durable-session-migrations/session-timeout-workflow.js";
export type { SessionTimeoutWorkflowInput } from "#execution/durable-session-migrations/session-timeout-workflow.js";
import { signalSessionTimeoutStep } from "#execution/session-timeout-steps.js";

/** Sleeps until the session deadline, then signals its driver. */
export async function sessionTimeoutWorkflow(value: unknown): Promise<void> {
  "use workflow";

  const input = migrateSessionTimeoutWorkflowInput(value);
  await sleep(input.deadline);
  await signalSessionTimeoutStep({ token: input.token });
}
