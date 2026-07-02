import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  ensureWorkflowContinuationSecurity,
  getWorkflowContinuationSecurity,
  readWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";

function makeSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "test-session",
    state,
  };
}

describe("workflow continuation security", () => {
  it("persists one stable signing key on session state", () => {
    const initial = makeSession({ authored: "preserved" });

    const secured = ensureWorkflowContinuationSecurity(initial);
    const security = getWorkflowContinuationSecurity(secured);

    expect(secured).not.toBe(initial);
    expect(secured.state?.authored).toBe("preserved");
    expect(security.signingKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(security.maxAgeMs).toBe(365 * 24 * 60 * 60 * 1000);
    expect(ensureWorkflowContinuationSecurity(secured)).toBe(secured);
    expect(getWorkflowContinuationSecurity(secured)).toEqual(security);
    expect(readWorkflowContinuationSecurity(secured)).toEqual(security);
  });

  it("rejects malformed persisted security state", () => {
    const session = makeSession({
      "eve.harness.workflowContinuationSecurity": {
        signingKey: "not-a-256-bit-key",
        version: 1,
      },
    });

    expect(() => ensureWorkflowContinuationSecurity(session)).toThrow(
      "Workflow continuation security state is missing or invalid.",
    );
    expect(() => getWorkflowContinuationSecurity(session)).toThrow(
      "Workflow continuation security state is missing or invalid.",
    );
    expect(readWorkflowContinuationSecurity(session)).toBeUndefined();
  });
});
