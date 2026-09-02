import { resumeHook, start } from "workflow/api";

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
  await reportReplica(input.replyTo, { digest, replica: input.replica });
}

/** `workflow/api` runs in steps; a body starts a child run through one. */
export async function startReplica(input: ReplicaInput): Promise<string> {
  "use step";

  const run = await start(planReplica, [input]);
  return run.runId;
}

async function reportReplica(replyTo: string, result: ReplicaResult): Promise<void> {
  "use step";

  await resumeHook(replyTo, result);
}
