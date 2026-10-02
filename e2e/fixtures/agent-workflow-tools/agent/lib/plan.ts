import { createHash } from "node:crypto";

/** The `sign_off_plan` request that asks a person to sign off; any other is a note on the plan. */
export const SIGN_OFF_REQUEST = "sign off";

export function describePlan(service: string): string {
  return `deploy ${service}`;
}

/** Hashing is a step: it runs in the app runtime and its result is recorded once. */
export async function hashPlan(plan: string): Promise<string> {
  "use step";
  return createHash("sha256").update(plan).digest("hex").slice(0, 12);
}
