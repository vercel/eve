import { describe, expect, it } from "vitest";

import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import {
  positionState,
  withPublished,
  withQueuedInput,
} from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";
import { createAuthorizationRequiredEvent, createInputRequestedEvent } from "#protocol/message.js";

// A session hands off only with nothing open, whatever kind of work it is: the projection
// reports every open turn, request, and sign-in, and execution state holds queued input.

function checkpoint(session: Pick<HarnessSession, "state">) {
  const value = createTestSessionState();
  return {
    serializedContext: {},
    sessionState: {
      ...value,
      snapshot: { session: { ...value.snapshot.session, state: session.state } },
    },
  };
}

function betweenTurns(): HarnessSession {
  return {
    agent: { dynamicModel: true, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "test-session",
    state: { ...positionState({ sequence: 1, turnId: "" }), authored: { values: [null, false] } },
  };
}

const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

describe("handoff state inspection", () => {
  it("accepts a session between turns with opaque authored state", () => {
    expect(isSessionStateIdleForHandoff(checkpoint(betweenTurns()))).toBe(true);
  });

  it("refuses an open turn", () => {
    expect(isSessionStateIdleForHandoff(checkpoint({ state: positionState(at) }))).toBe(false);
  });

  it("refuses an open request", () => {
    const asked = withPublished(betweenTurns(), [
      createInputRequestedEvent({
        requests: [
          {
            action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
            kind: "tool-approval",
            prompt: "Approve deploy?",
            requestId: "approval-1",
          },
        ],
        ...at,
      }),
    ]);
    expect(isSessionStateIdleForHandoff(checkpoint(asked))).toBe(false);
  });

  it("refuses an open sign-in", () => {
    const asked = withPublished(betweenTurns(), [
      createAuthorizationRequiredEvent({
        attemptId: "attempt-1",
        description: "Sign in to Linear",
        name: "linear",
        ...at,
      }),
    ]);
    expect(isSessionStateIdleForHandoff(checkpoint(asked))).toBe(false);
  });

  it("refuses input the session holds until it can run", () => {
    const queued = withQueuedInput(betweenTurns(), { message: "Alice asks for a summary." });
    expect(isSessionStateIdleForHandoff(checkpoint(queued))).toBe(false);
  });
});
