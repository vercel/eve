import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey } from "#context/keys.js";
import { reconcileSessionContinuationToken } from "#execution/workflow-steps.js";
import type { HarnessSession } from "#harness/types.js";

function makeSession(continuationToken: string): HarnessSession {
  return {
    agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken,
    history: [],
    sessionId: "session_test",
  };
}

describe("reconcileSessionContinuationToken", () => {
  it("returns the same session when no token write happened during the step", () => {
    const ctx = new ContextContainer();
    const session = makeSession("slack:C123:");

    const next = reconcileSessionContinuationToken(ctx, session);

    expect(next).toBe(session);
  });

  it("returns the same session when the live token matches the session token", () => {
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C123:");
    const session = makeSession("slack:C123:");

    const next = reconcileSessionContinuationToken(ctx, session);

    expect(next).toBe(session);
  });

  it("re-stamps the session's continuation token when a handler called setContinuationToken", () => {
    // The session handle's `setContinuationToken(...)` writes through
    // to ContinuationTokenKey during the step. After the step,
    // reconcile picks the new token up and stamps it onto the
    // HarnessSession the workflow body reads back.
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "slack:C123:1800000000.123456");
    const session = makeSession("slack:C123:");

    const next = reconcileSessionContinuationToken(ctx, session);

    expect(next).not.toBe(session);
    expect(next.continuationToken).toBe("slack:C123:1800000000.123456");
    // Every other field is preserved.
    expect(next.sessionId).toBe(session.sessionId);
    expect(next.agent).toBe(session.agent);
    expect(next.compaction).toBe(session.compaction);
    expect(next.history).toBe(session.history);
  });
});
