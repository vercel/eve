import { resumeHook } from "workflow/api";

import { describePlan, hashPlan } from "./plan.ts";

export interface ReplicaInput {
  readonly replica: number;
  readonly replyTo: string;
  readonly service: string;
}

export interface ReplicaResult {
  readonly digest: string;
  readonly replica: number;
}

/**
 * A standalone workflow the fan-out tool starts once per replica. It reports
 * its result to the reply hook the caller passed in.
 */
export async function planReplica(input: ReplicaInput): Promise<void> {
  "use workflow";

  const digest = await hashPlan(`${describePlan(input.service)} #${input.replica}`);
  await resumeHook(input.replyTo, { digest, replica: input.replica });
}
