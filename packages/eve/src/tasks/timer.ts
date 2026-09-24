import { sleep } from "#compiled/@workflow/core/index.js";

import { signalTaskDeadlineStep } from "#tasks/timer-steps.js";

// One sleeper run per owner. It signals the owner's stable inbox, and every
// signal is re-evaluated against the task table, so a stale or duplicate
// timer is harmless. A successor owner re-arms rather than trusting a timer
// its predecessor's deployment may have retired.

export interface TaskTimerWorkflowInput {
  /** The owner run that armed the timer. */
  readonly ownerRunId: string;
  /** The owner's stable session inbox. */
  readonly token: string;
  readonly wakeAt: string;
}

/** Sleeps until the owner's next task deadline, then signals the owner. */
export async function taskTimerWorkflow(input: TaskTimerWorkflowInput): Promise<void> {
  "use workflow";

  await sleep(new Date(input.wakeAt));
  await signalTaskDeadlineStep(input);
}
