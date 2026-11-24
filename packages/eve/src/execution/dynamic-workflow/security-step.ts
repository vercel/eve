import { randomBytes } from "node:crypto";

import {
  WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS,
  type WorkflowProgramContinuationSecurity,
} from "#execution/dynamic-workflow/schema.js";

const WORKFLOW_PROGRAM_CONTINUATION_HEADROOM_MS = 7 * 24 * 60 * 60 * 1_000;
const WORKFLOW_PROGRAM_CONTINUATION_MAX_AGE_MS =
  WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS * 1_000 + WORKFLOW_PROGRAM_CONTINUATION_HEADROOM_MS;

export async function createWorkflowProgramContinuationSecurityStep(): Promise<WorkflowProgramContinuationSecurity> {
  "use step";

  return {
    maxAgeMs: WORKFLOW_PROGRAM_CONTINUATION_MAX_AGE_MS,
    signingKey: randomBytes(32).toString("base64url"),
  };
}
