import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSession } from "#execution/durable-session-store.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { answerTaskCancel } from "#execution/tasks/session.js";
import { applyTaskRunMessageStep } from "#execution/tasks/steps.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import { upsertProxyInputRequestState } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { withPublished } from "#internal/testing/session-machine.js";
import { createInputRequestedEvent } from "#protocol/message.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

// No workflow runtime runs here: the run's cancel hook is a stub, and the
// stream is recorded with each event's origin, since relayed input must not
// reach the session's own instrumentation.
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn(async () => {}) }));
const { published } = vi.hoisted(() => ({ published: [] as unknown[] }));
vi.mock("#execution/publish-session-events.js", () => {
  const publisher =
    (origin: "own" | "relayed") =>
    async (
      target: {
        readonly serializedContext: Record<string, unknown>;
        readonly sessionState: unknown;
      },
      events: readonly unknown[],
    ) => {
      published.push(...events.map((event) => ({ event, origin })));
      return { serializedContext: target.serializedContext, sessionState: target.sessionState };
    };
  return { publishSessionEvents: publisher("own"), relaySessionEvents: publisher("relayed") };
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
    const cursor = cursorFor(session);

    await answerTaskCancel(cursor, {
      callId: "cancel-call",
      kind: "task_cancel",
      taskId: research.taskId,
    });

    // Publishing drops the withdrawn question's route; here it only records what was published.
    expect(published).toEqual([
      {
        event: {
          data: {
            ...REQUEST_EVENT,
            resolutions: [
              { kind: "question", outcome: "cancelled", requestId: "research-run-ask-1" },
            ],
          },
          type: "input.resolved",
        },
        origin: "relayed",
      },
      {
        event: {
          data: {
            callId: "research-call",
            cancel: { reason: "task_cancel" },
            kind: "tool",
            name: "research",
            status: "cancelled",
            taskId: research.taskId,
            turnId: "turn_1",
          },
          type: "task.settled",
        },
        origin: "own",
      },
    ]);
  });
});

describe("applyTaskRunMessageStep", () => {
  it("withdraws the questions of a task() run that fails on its own, and only those", async () => {
    const research = startedTask(readTaskTable(undefined), "research");
    const summarize = startedTask(research.table, "summarize");
    let session: DurableSession = writeTaskTable(
      createTestSessionState({ sessionId: "session-1" }).snapshot.session,
      summarize.table,
    );
    session = withQuestion(session, "research-run");
    session = withQuestion(session, "summarize-run");
    const cursor = cursorFor(session);

    await cursor.advance((state) =>
      applyTaskRunMessageStep({
        ...state,
        message: {
          from: {
            callId: "research-call",
            input: {},
            runId: "research-run",
            sequence: 3,
            stepIndex: 1,
            taskId: research.taskId,
            toolName: "research",
            turnId: "turn_1",
          },
          kind: "outcome",
          result: { error: "The research service is unavailable.", status: "failed" },
        },
      }),
    );

    // Publishing drops the withdrawn question's route; here it only records what was published.
    expect(published).toEqual([
      {
        event: {
          data: {
            ...REQUEST_EVENT,
            resolutions: [
              { kind: "question", outcome: "cancelled", requestId: "research-run-ask-1" },
            ],
          },
          type: "input.resolved",
        },
        origin: "relayed",
      },
      {
        event: {
          data: {
            callId: "research-call",
            error: { message: "The research service is unavailable." },
            kind: "tool",
            name: "research",
            status: "failed",
            taskId: research.taskId,
            turnId: "turn_1",
          },
          type: "task.settled",
        },
        origin: "own",
      },
    ]);
  });
});

function cursorFor(session: DurableSession): SessionStateCursor {
  return new SessionStateCursor({
    history: [],
    inbox: { claimSessionHooks: vi.fn() } as Partial<SessionInbox> as SessionInbox,
    serializedContext: {},
    sessionState: {
      ...createTestSessionState({ sessionId: "session-1" }),
      snapshot: { session },
    },
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}

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

/** A question the task's run asked, relayed as the session relays it. */
function withQuestion(session: DurableSession, runId: string): DurableSession {
  const requestId = `${runId}-ask-1`;
  session = withPublished(session as HarnessSession, [
    createInputRequestedEvent({
      callId: `${runId.replace("-run", "")}-call`,
      requests: [
        {
          action: { callId: requestId, input: {}, kind: "tool-call", toolName: "ask" },
          kind: "question",
          prompt: "Which region should Alice's report cover?",
          requestId,
        },
      ],
      ...REQUEST_EVENT,
    }),
  ]);
  const state = upsertProxyInputRequestState({
    entries: [
      [
        requestId,
        {
          childContinuationToken: requestId,
          event: REQUEST_EVENT,
          kind: "question",
          runId,
          workflowAsk: { control: `${runId}-control`, question: {} },
        },
      ],
    ],
    forChildContinuationToken: requestId,
    state: session.state,
  });
  return { ...session, state };
}
