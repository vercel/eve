import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session-timeout-steps.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

/** Workflow-body handle that targets a durable deadline at the stable command inbox. */
export interface SessionTimeoutControl {
  dispose(): Promise<void>;
  start(): Promise<void>;
}

/** Creates a timer controller for one stable session command inbox. */
export function createSessionTimeoutControl(input: {
  readonly deadline: Date;
  readonly sessionId: string;
}): SessionTimeoutControl {
  let active: { readonly runId: string } | undefined;

  return {
    async dispose(): Promise<void> {
      if (active === undefined) return;
      const current = active;
      active = undefined;
      await cancelSessionTimeoutStep({ runId: current.runId });
    },

    async start(): Promise<void> {
      if (active !== undefined) return;
      active = await startSessionTimeoutStep({
        deadline: input.deadline,
        ownerRunId: getWorkflowMetadata().workflowRunId,
        token: sessionCommandHookToken(input.sessionId),
      });
    },
  };
}
