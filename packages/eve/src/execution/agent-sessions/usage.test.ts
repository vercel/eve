import { describe, expect, it, vi } from "vitest";

import { hasRunUsage } from "#execution/agent-sessions/usage.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { SessionExecution } from "#execution/session/turn.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import {
  getSessionTokenUsage,
  getSessionUsageLimitViolation,
  setTurnUsageState,
  takeSessionUsageDelta,
  toUsage,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

function usage(inputTokens: number, costUsd?: number): TokenUsage {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, inputTokens, outputTokens: 0 };
}

/** A session that has spent `ownInputTokens` itself, under `limits`. */
function session(input: {
  readonly limits?: HarnessSession["limits"];
  readonly ownInputTokens: number;
}): { readonly cursor: SessionStateCursor; readonly execution: SessionExecution } {
  const base = createTestSessionState({ sessionId: "alice-session" });
  const own = { ...usage(input.ownInputTokens), costUsd: 0, sawCost: false };
  const snapshot = setTurnUsageState(
    { ...base.snapshot.session, limits: input.limits },
    { ...own, session: own, turnId: "turn_1" },
  );
  const inbox = {
    claimSessionHooks: vi.fn(),
    onAgentStarted: () => () => {},
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
  } as Partial<SessionInbox> as SessionInbox;
  const cursor = new SessionStateCursor({
    inbox,
    serializedContext: {},
    sessionState: { ...base, snapshot: { session: snapshot } },
    sessionWritable: new WritableStream<Uint8Array>(),
  });
  const execution = new SessionExecution({
    cursor,
    inbox,
    queue: new SessionInputQueue(),
    sessionId: base.sessionId,
  });
  return { cursor, execution };
}

function committed(cursor: SessionStateCursor): DurableSession {
  return cursor.sessionState.snapshot.session;
}

function spent(cursor: SessionStateCursor): TokenUsage {
  return toUsage(getSessionTokenUsage(committed(cursor)));
}

function run(runId: string, taskId?: string): WorkflowToolRunRef {
  return {
    callId: `${runId}-call`,
    input: {},
    runId,
    sequence: 1,
    stepIndex: 0,
    taskId,
    toolName: "reviewer",
    turnId: "turn_1",
  };
}

describe("delegated agent usage", () => {
  it("counts each turn a run reports once, however its reports arrive, against the session's limits", async () => {
    const alice = session({ limits: { maxInputTokensPerSession: 1_000 }, ownInputTokens: 100 });
    const from = run("reviewer-run", "reviewer-7k2m9q");
    // Turn 1 is redelivered, and turn 3's report overtakes turn 2's.
    for (const [sequence, total] of [
      [1, usage(300, 0.25)],
      [1, usage(300, 0.25)],
      [3, usage(700, 0.75)],
      [2, usage(500, 0.5)],
    ] as const) {
      await alice.execution.handleWorkflowMessage({ from, kind: "usage", sequence, usage: total });
    }

    expect(spent(alice.cursor)).toEqual(usage(800, 0.75));
    expect(getSessionUsageLimitViolation(committed(alice.cursor))).toBeNull();

    await alice.execution.handleWorkflowMessage({
      from,
      kind: "usage",
      sequence: 4,
      usage: usage(900),
    });

    expect(getSessionUsageLimitViolation(committed(alice.cursor))).toEqual({
      kind: "input",
      limit: 1_000,
      usedTokens: 1_000,
    });
  });

  it("counts a chain of agents at every level", async () => {
    // Alice's session delegates to Bob's, which delegates to Carol's.
    const alice = session({ ownInputTokens: 10 });
    const bob = session({ ownInputTokens: 50 });
    await bob.execution.handleWorkflowMessage({
      from: run("carol-run", "carol-4h8p2x"),
      kind: "usage",
      sequence: 1,
      usage: usage(200),
    });
    // Bob's turn reports what his session spent since his last report.
    const bobTurn = takeSessionUsageDelta(committed(bob.cursor)).delta;

    await alice.execution.handleWorkflowMessage({
      from: run("bob-run", "bob-9t3v6w"),
      kind: "usage",
      sequence: 1,
      usage: bobTurn,
    });

    expect(spent(alice.cursor)).toEqual(usage(260));
  });

  it.each([
    { entry: "task", taskId: "reviewer-7k2m9q" },
    { entry: "execute", taskId: undefined },
  ])("keeps the usage and forgets the run once its $entry run ends", async ({ taskId }) => {
    const alice = session({ ownInputTokens: 0 });
    const from = run("reviewer-run", taskId);
    await alice.execution.handleWorkflowMessage({
      from,
      kind: "usage",
      sequence: 1,
      usage: usage(300),
    });

    await alice.execution.handleWorkflowMessage({
      from,
      kind: "outcome",
      result: { output: "Reviewed.", status: "completed" },
    });

    expect(spent(alice.cursor)).toEqual(usage(300));
    expect(hasRunUsage(committed(alice.cursor).state, "reviewer-run")).toBe(false);
  });
});
