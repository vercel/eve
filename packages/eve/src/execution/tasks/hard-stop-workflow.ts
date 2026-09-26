import { sleep } from "#compiled/@workflow/core/index.js";

import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

/** Wakes the session when a cancelled task run is due for a hard stop. */
export interface TaskCancelDueMessage {
  readonly kind: "task.cancel-due";
}

export interface TaskHardStopWorkflowInput {
  /** When the earliest cancelled run is due, in epoch milliseconds. */
  readonly dueAt: number;
  /** The session inbox to wake. */
  readonly inbox: string;
}

const CANCEL_DUE: TaskCancelDueMessage = { kind: "task.cancel-due" };

/**
 * The session's one sleeper: it sleeps until the earliest pending cancel
 * confirmation is due, then wakes the session to hard-stop overdue runs.
 */
export async function taskHardStopWorkflow(input: TaskHardStopWorkflowInput): Promise<void> {
  "use workflow";

  await sleep(new Date(input.dueAt));
  await resumeHookStep(input.inbox, CANCEL_DUE, { ifPresent: true });
}
