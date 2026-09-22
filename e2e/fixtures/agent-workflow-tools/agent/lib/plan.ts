import { createHash } from "node:crypto";

export function describePlan(service: string): string {
  return `deploy ${service}`;
}

/** Hashing is a step: it runs in the app runtime and its result is recorded once. */
export async function hashPlan(plan: string): Promise<string> {
  "use step";
  return createHash("sha256").update(plan).digest("hex").slice(0, 12);
}
