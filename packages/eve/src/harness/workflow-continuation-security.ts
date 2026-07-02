import { randomBytes } from "node:crypto";

import type { HarnessSession } from "#harness/types.js";
import type { WorkflowSandboxContinuationSecurity } from "#shared/workflow-sandbox.js";

const WORKFLOW_CONTINUATION_SECURITY_KEY = "eve.harness.workflowContinuationSecurity";
const WORKFLOW_CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

interface StoredWorkflowContinuationSecurity {
  readonly signingKey: string;
  readonly version: 1;
}

export function ensureWorkflowContinuationSecurity(session: HarnessSession): HarnessSession {
  if (session.state?.[WORKFLOW_CONTINUATION_SECURITY_KEY] !== undefined) {
    getWorkflowContinuationSecurity(session);
    return session;
  }

  return {
    ...session,
    state: {
      ...session.state,
      [WORKFLOW_CONTINUATION_SECURITY_KEY]: {
        signingKey: randomBytes(32).toString("base64url"),
        version: 1,
      } satisfies StoredWorkflowContinuationSecurity,
    },
  };
}

export function readWorkflowContinuationSecurity(
  session: HarnessSession,
): WorkflowSandboxContinuationSecurity | undefined {
  const stored = session.state?.[WORKFLOW_CONTINUATION_SECURITY_KEY];
  if (
    typeof stored !== "object" ||
    stored === null ||
    (stored as { version?: unknown }).version !== 1 ||
    typeof (stored as { signingKey?: unknown }).signingKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test((stored as { signingKey: string }).signingKey)
  ) {
    return undefined;
  }

  return {
    signingKey: (stored as StoredWorkflowContinuationSecurity).signingKey,
    // A parked workflow can legitimately wait far beyond code mode's one-hour default.
    maxAgeMs: WORKFLOW_CONTINUATION_MAX_AGE_MS,
  };
}

export function getWorkflowContinuationSecurity(
  session: HarnessSession,
): WorkflowSandboxContinuationSecurity {
  const security = readWorkflowContinuationSecurity(session);
  if (security === undefined) {
    throw new Error("Workflow continuation security state is missing or invalid.");
  }
  return security;
}
