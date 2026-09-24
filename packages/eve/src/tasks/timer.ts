import { sleep } from "#compiled/@workflow/core/index.js";

import type { HardStopTarget } from "#tasks/timer-steps.js";
import { hardStopTaskChildrenStep, signalTaskDeadlineStep } from "#tasks/timer-steps.js";

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
  /**
   * Set when the owner session ended: the children it asked to stop, to
   * hard-stop at `wakeAt` if they are still running. The ended owner is not
   * signalled.
   */
  readonly hardStop?: readonly HardStopTarget[];
  /**
   * Set when the request to end the `hardStop` children did not reach them:
   * at `wakeAt` the request goes out again with this reason, and only a child
   * it still cannot reach is hard-stopped, so the others run their own
   * cleanup as they end.
   */
  readonly endReason?: string;
}

/** Sleeps until the owner's next task deadline, then signals the owner or hard-stops its children. */
export async function taskTimerWorkflow(input: TaskTimerWorkflowInput): Promise<void> {
  "use workflow";

  await sleep(new Date(input.wakeAt));
  if (input.hardStop !== undefined) {
    await hardStopTaskChildrenStep(input.hardStop, input.endReason);
    return;
  }
  await signalTaskDeadlineStep(input);
}
