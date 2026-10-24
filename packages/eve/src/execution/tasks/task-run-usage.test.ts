import { describe, expect, it, vi } from "vitest";

import type { DurableSession, DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import {
  isAppliedRunMessage,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { cancelTasksStep } from "#execution/tasks/steps.js";
import {
  cancelTask,
  createTask,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { sessionUsage } from "#harness/session-usage.js";
import { checkSessionUsageLimit } from "#harness/hitl/budget.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { withSessionUsage } from "#internal/testing/session-usage.js";
import type { TokenUsage } from "#shared/token-usage.js";

const publishedFacts = vi.hoisted((): SessionEvent[] => []);
const sentCommands = vi.hoisted(() => vi.fn(async (_token: string, _message: unknown) => {}));

vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: sentCommands }));

vi.mock("#execution/stop-runs.js", () => ({
  stopRuns: async (
    targets: readonly { readonly run: { readonly runId: string }; readonly ends: boolean }[],
  ) => targets.filter((target) => target.ends).map((target) => target.run.runId),
  waitedCallRuns: () => [],
}));

// A task step's commit folds what it decides into the session's saved view, as the writer does.
vi.mock("#execution/publish-session-events.js", async () => {
  const { readDurableSession, replaceDurableSessionSnapshot } =
    await import("#execution/durable-session-store.js");
  const { sessionView } = await import("#harness/session-machine/commit.js");
  const { SESSION_PROJECTION_STATE_KEY, storedProjection } =
    await import("#harness/session-machine/view.js");
  const { copyView, foldReceivedEvent } = await import("#protocol/session-projection/fold.js");
  return {
    followInterruptedAttempt: (_writable: unknown, state: DurableSessionState) => state,
    readOrphanedLines: async () => [],
    commitSessionStep: async (
      target: { serializedContext: Record<string, unknown>; sessionState: DurableSessionState },
      decide: (view: SessionView) => readonly { readonly events: readonly SessionEvent[] }[],
    ) => {
      const session = readDurableSession(target.sessionState);
      const projection = storedProjection(session.state);
      const view = copyView(projection.view);
      for (const transition of decide(sessionView(projection, session.state)))
        for (const event of transition.events) {
          publishedFacts.push(event);
          foldReceivedEvent(view, { ...event, meta: { endOfLine: false } });
        }
      const state = { ...session.state, [SESSION_PROJECTION_STATE_KEY]: { ...projection, view } };
      return {
        serializedContext: target.serializedContext,
        sessionState: replaceDurableSessionSnapshot({
          session: { ...session, state },
          state: target.sessionState,
        }),
      };
    },
  };
});

function usage(inputTokens: number, costUsd?: number): TokenUsage {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, inputTokens, outputTokens: 0 };
}

/**
 * A session that has spent `ownInputTokens` itself, with one
 * agent task, `name`, whose run is working on a call.
 */
function sessionWithTask(input: {
  readonly name: string;
  readonly ownInputTokens: number;
  readonly cancelled?: boolean;
}): {
  readonly cursor: SessionStateCursor;
  readonly execution: { handleWorkflowMessage(message: WorkflowToolRunMessage): Promise<unknown> };
  readonly from: WorkflowToolRunRef;
} {
  const base = createTestSessionState({ sessionId: `${input.name}-parent` });
  const created = createTask(readTaskTable(undefined), {
    callId: `${input.name}-call`,
    kind: "agent",
    name: input.name,
    resumable: true,
    turnId: "turn_1",
  });
  const runId = `${input.name}-run`;
  const table = recordTaskRun(created.table, created.taskId, {
    hookToken: `${runId}-control`,
    runId,
  });
  const snapshot = writeTaskTable(
    withSessionUsage(base.snapshot.session, usage(input.ownInputTokens)),
    input.cancelled ? cancelTask(table, created.taskId).table : table,
  );
  const inbox = {
    claimSessionHooks: vi.fn(),
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
    takeLeading: () => [],
  } as Partial<SessionInbox> as SessionInbox;
  const cursor = new SessionStateCursor({
    history: [],
    inbox,
    serializedContext: {},
    sessionState: { ...base, snapshot: { session: snapshot } },
    sessionWritable: new WritableStream<Uint8Array>(),
  });
  const execution = {
    handleWorkflowMessage(message: WorkflowToolRunMessage) {
      if (!isAppliedRunMessage(message)) throw new Error("Expected a task run message.");
      return cursor.advance((state) => applyRunMessagesStep({ ...state, messages: [message] }));
    },
  };
  const from: WorkflowToolRunRef = {
    callId: `${input.name}-call`,
    input: {},
    runId,
    sequence: 1,
    stepIndex: 0,
    taskId: created.taskId,
    toolName: input.name,
    turnId: "turn_1",
  };
  return { cursor, execution, from };
}

function committed(cursor: SessionStateCursor): DurableSession {
  return cursor.sessionState.snapshot.session;
}

function spent(cursor: SessionStateCursor): TokenUsage {
  return sessionUsage(committed(cursor));
}

describe("delegated agent usage", () => {
  it("ends only the recorded cancelled run when its control hook becomes ready", async () => {
    const alice = sessionWithTask({ name: "reviewer", ownInputTokens: 100, cancelled: true });
    publishedFacts.length = 0;
    sentCommands.mockClear();
    await alice.execution.handleWorkflowMessage({
      from: { ...alice.from, runId: "stale-run" },
      kind: "started",
    });
    expect(sentCommands).not.toHaveBeenCalled();

    await alice.execution.handleWorkflowMessage({ from: alice.from, kind: "started" });
    expect(sentCommands).toHaveBeenCalledExactlyOnceWith("reviewer-run-control", {
      kind: "end",
      reason: "The task was cancelled.",
    });
    expect(publishedFacts).toEqual([]);
    const task = readTaskTable(committed(alice.cursor).state).tasks[0];
    expect(task?.cancelled).toBe(true);
    expect(task?.run?.runId).toBe(alice.from.runId);
    expect(task?.calls).toEqual([]);

    await alice.execution.handleWorkflowMessage({
      from: alice.from,
      kind: "outcome",
      result: { status: "cancelled" },
    });
    expect(readTaskTable(committed(alice.cursor).state).tasks[0]?.run).toBeUndefined();
    expect(publishedFacts).toEqual([]);
  });

  it("counts cancelled run usage as it arrives, then only the final delta without restoring its task", async () => {
    const alice = sessionWithTask({
      name: "reviewer",
      ownInputTokens: 100,
      cancelled: true,
    });
    publishedFacts.length = 0;
    await alice.execution.handleWorkflowMessage({
      from: { ...alice.from, runId: "stale-run" },
      kind: "usage",
      usage: usage(900),
    });
    expect(spent(alice.cursor)).toEqual(usage(100));

    const report = { from: alice.from, kind: "usage" as const, usage: usage(300, 0.25) };
    await alice.execution.handleWorkflowMessage(report);
    await alice.execution.handleWorkflowMessage(report);

    expect(spent(alice.cursor)).toEqual(usage(400, 0.25));
    expect(
      checkSessionUsageLimit({
        canAsk: false,
        session: committed(alice.cursor),
        turnSequence: 0,
        usage: spent(alice.cursor),
        limit: ({ window }) => window.inputTokens >= 400,
      }),
    ).toMatchObject({
      kind: "fail",
      code: "SESSION_USAGE_LIMIT_REACHED",
      details: { total: { inputTokens: 400 } },
    });
    expect(readTaskTable(committed(alice.cursor).state).tasks[0]?.run?.runId).toBe(
      alice.from.runId,
    );
    expect(publishedFacts.filter((event) => event.type === "usage.recorded")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ kind: "delegated-late", usage: usage(300, 0.25) }),
      }),
    ]);
    expect(
      publishedFacts.filter((event) => event.type === "usage.recorded").map((event) => event.scope),
    ).toEqual([undefined]);

    const outcome = {
      from: alice.from,
      kind: "outcome" as const,
      result: { status: "cancelled" as const },
      usage: usage(500, 0.4),
    };
    await alice.execution.handleWorkflowMessage(outcome);
    await alice.execution.handleWorkflowMessage(outcome);
    await alice.execution.handleWorkflowMessage(report);

    expect(spent(alice.cursor)).toEqual(usage(600, 0.4));
    expect(publishedFacts.filter((event) => event.type === "usage.recorded")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ kind: "delegated-late" }) }),
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "delegated-late",
          usage: expect.objectContaining({ inputTokens: 200 }),
        }),
      }),
    ]);
    expect(
      publishedFacts.filter((event) => event.type === "usage.recorded").map((event) => event.scope),
    ).toEqual([undefined, undefined]);
    const task = readTaskTable(committed(alice.cursor).state).tasks[0];
    expect(task?.calls).toEqual([]);
    expect(task?.run).toBeUndefined();
  });

  it("reclaims a run address once stopping it confirms outright cancellation", async () => {
    const alice = sessionWithTask({ name: "reviewer", ownInputTokens: 100 });
    await alice.cursor.advance((state) =>
      cancelTasksStep({
        ...state,
        reason: "task-cancel",
        taskIds: [alice.from.taskId!],
      }),
    );

    const task = readTaskTable(committed(alice.cursor).state).tasks[0];
    expect(task?.calls).toEqual([]);
    expect(task?.run).toBeUndefined();
  });

  it("counts a task's usage once from its replies, usage reports, and outcome, however often they arrive, against the session's limits", async () => {
    const alice = sessionWithTask({
      name: "reviewer",
      ownInputTokens: 100,
    });
    const { from } = alice;
    const reply = {
      callIds: [from.callId],
      from,
      kind: "reply" as const,
      output: "The plan looks ready.",
      usage: usage(300, 0.25),
    };
    // The reply is delivered twice.
    await alice.execution.handleWorkflowMessage(reply);
    await alice.execution.handleWorkflowMessage(reply);

    expect(spent(alice.cursor)).toEqual(usage(400, 0.25));

    // Alice cancels the reviewer's next turn; no reply carries its usage.
    await alice.execution.handleWorkflowMessage({ from, kind: "usage", usage: usage(600, 0.5) });

    expect(spent(alice.cursor)).toEqual(usage(700, 0.5));
    const budget = () =>
      checkSessionUsageLimit({
        canAsk: false,
        session: committed(alice.cursor),
        turnSequence: 0,
        usage: spent(alice.cursor),
        limit: ({ window }) => window.inputTokens >= 1_000,
      });
    expect(budget().kind).toBe("within");

    const outcome = {
      from,
      kind: "outcome" as const,
      result: { output: "Reviewed.", status: "completed" as const },
      usage: usage(900, 0.75),
    };
    // The outcome is delivered twice too; the second arrives after the task's run finished.
    await alice.execution.handleWorkflowMessage(outcome);
    await alice.execution.handleWorkflowMessage(outcome);

    expect(spent(alice.cursor)).toEqual(usage(1_000, 0.75));
    expect(budget()).toMatchObject({
      kind: "fail",
      code: "SESSION_USAGE_LIMIT_REACHED",
      details: { total: { inputTokens: 1_000 } },
    });
  });
});
