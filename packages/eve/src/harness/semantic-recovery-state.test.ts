import { describe, expect, it } from "vitest";

import {
  clearPendingSemanticRecovery,
  nextSemanticRecoveryAttempt,
  setPendingSemanticRecovery,
} from "#harness/semantic-recovery-state.js";
import type { HarnessSession } from "#harness/types.js";

const baseSession = {} as HarnessSession;

describe("semantic recovery state", () => {
  it("starts a recovery budget and stops at its maximum", () => {
    const session = setPendingSemanticRecovery(baseSession, {
      attempt: 1,
      maxAttempts: 2,
      semanticErrorId: "rate-limit",
      turnId: "turn_0",
    });
    expect(
      nextSemanticRecoveryAttempt({
        maxAttempts: 2,
        semanticErrorId: "rate-limit",
        state: session.state,
        turnId: "turn_0",
      }),
    ).toBe(2);
    expect(
      nextSemanticRecoveryAttempt({
        maxAttempts: 1,
        semanticErrorId: "rate-limit",
        state: session.state,
        turnId: "turn_0",
      }),
    ).toBeUndefined();
  });

  it("does not carry a budget to another turn and clears it on settlement", () => {
    const session = setPendingSemanticRecovery(baseSession, {
      attempt: 1,
      maxAttempts: 1,
      semanticErrorId: "rate-limit",
      turnId: "turn_0",
    });
    expect(
      nextSemanticRecoveryAttempt({
        maxAttempts: 1,
        semanticErrorId: "rate-limit",
        state: session.state,
        turnId: "turn_1",
      }),
    ).toBe(1);
    expect(clearPendingSemanticRecovery(session).state).not.toHaveProperty(
      "eve.harness.semanticRecovery",
    );
  });
});
