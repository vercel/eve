import { randomBytes } from "node:crypto";

import type { WorkflowProgramContinuationSecurity } from "#execution/dynamic-workflow/schema.js";

const WORKFLOW_PROGRAM_CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Creates replay-stable signing material without exposing it to generated code. */
export async function createWorkflowProgramContinuationSecurityStep(): Promise<WorkflowProgramContinuationSecurity> {
  "use step";

  return {
    maxAgeMs: WORKFLOW_PROGRAM_CONTINUATION_MAX_AGE_MS,
    signingKey: randomBytes(32).toString("base64url"),
  };
}
