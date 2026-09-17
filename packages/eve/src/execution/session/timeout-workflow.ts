import { sleep } from "#compiled/@workflow/core/index.js";

import { signalSessionTimeoutStep } from "#execution/session/timeout-steps.js";

export interface SessionTimeoutWorkflowInput {
  readonly deadline: Date;
  /** Owner run that armed the timer. */
  readonly ownerRunId: string;
  readonly token: string;
}

/** Sleeps until the session deadline, then signals its current owner. */
export async function sessionTimeoutWorkflow(input: SessionTimeoutWorkflowInput): Promise<void> {
  "use workflow";

  await sleep(input.deadline);
  await signalSessionTimeoutStep({ ownerRunId: input.ownerRunId, token: input.token });
}
