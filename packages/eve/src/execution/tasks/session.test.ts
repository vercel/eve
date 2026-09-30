import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSession } from "#execution/durable-session-store.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { answerTaskCancel } from "#execution/tasks/session.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

// No workflow runtime runs here: the run's cancel hook is a stub, and the stream is recorded.
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn(async () => {}) }));
const { published } = vi.hoisted(() => ({ published: [] as unknown[] }));
vi.mock("#execution/publish-session-events.js", () => {
  const publish = async (
    target: { readonly serializedContext: Record<string, unknown>; readonly sessionState: unknown },
    events: readonly unknown[],
  ) => {
    published.push(...events);
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  };
  return { publishSessionEvents: publish, relaySessionEvents: publish };
});

const REQUEST_EVENT = { sequence: 3, stepIndex: 1, turnId: "turn_1" };

beforeEach(() => {
  published.length = 0;
});

describe("answerTaskCancel", () => {
  it("withdraws the questions of the task() run it cancels, and only those", async () => {
    const research = startedTask(readTaskTable(undefined), "research");
    const summarize = startedTask(research.table, "summarize");
    let session: DurableSession = writeTaskTable(
      createTestSessionState({ sessionId: "session-1" }).snapshot.session,
      summarize.table,
    );
    session = withQuestion(session, "research-run");
    session = withQuestion(session, "summarize-run");
    const cursor = new SessionStateCursor({
      inbox: { claimSessionHooks: vi.fn() } as Partial<SessionInbox> as SessionInbox,
      serializedContext: {},
      sessionState: {
        ...createTestSessionState({ sessionId: "session-1" }),
        snapshot: { session },
      },
      sessionWritable: new WritableStream<Uint8Array>(),
    });

    await answerTaskCancel(cursor, {
      callId: "cancel-call",
      kind: "task_cancel",
      taskId: research.taskId,
    });

    const committed = cursor.sessionState.snapshot.session;
    expect([...getProxyInputRequests(committed.state).keys()]).toEqual(["summarize-run-ask-1"]);
    expect(published).toEqual([
      {
        data: {
          ...REQUEST_EVENT,
          resolutions: [
            { kind: "question", outcome: "cancelled", requestId: "research-run-ask-1" },
          ],
        },
        type: "input.resolved",
      },
      {
        data: {
          callId: "research-call",
          kind: "tool",
          name: "research",
          status: "cancelled",
          taskId: research.taskId,
          turnId: "turn_1",
        },
        type: "task.settled",
      },
    ]);
  });
});

/** A working `task()` task whose run has started. */
function startedTask(
  table: TaskTable,
  name: string,
): { readonly table: TaskTable; readonly taskId: string } {
  const created = createTask(table, {
    callId: `${name}-call`,
    kind: "tool",
    name,
    resumable: false,
    turnId: "turn_1",
  });
  const runId = `${name}-run`;
  const recorded = recordTaskRun(created.table, created.taskId, {
    hookToken: `${runId}-control`,
    runId,
  });
  return {
    table: markTaskRunStarted(recorded, created.taskId, runId).table,
    taskId: created.taskId,
  };
}

function withQuestion(session: DurableSession, runId: string): DurableSession {
  const requestId = `${runId}-ask-1`;
  const state = upsertProxyInputRequestState({
    entries: [
      [
        requestId,
        {
          childContinuationToken: requestId,
          event: REQUEST_EVENT,
          kind: "question",
          workflowAsk: { control: `${runId}-control`, question: {}, runId },
        },
      ],
    ],
    forChildContinuationToken: requestId,
    state: session.state,
  });
  return { ...session, state };
}
