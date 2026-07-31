import { sleep } from "#compiled/@workflow/core/index.js";

import { signalSessionTimeoutStep } from "#execution/session-timeout-steps.js";

export interface SessionTimeoutWorkflowInput {
  readonly deadline: Date;
  readonly token: string;
}

/** Sleeps until the session deadline, then signals its driver. */
export async function sessionTimeoutWorkflow(input: SessionTimeoutWorkflowInput): Promise<void> {
  "use workflow";

  await sleep(input.deadline);
  await signalSessionTimeoutStep({ token: input.token });
}
