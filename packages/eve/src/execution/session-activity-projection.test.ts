import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivityObserverKey,
  ActivityPendingBlockersKey,
  ActivityTaskCallsKey,
} from "#context/keys.js";
import {
  retainAnswerableActivityBlockers,
  updateActivityState,
} from "#execution/activity-cohort.js";
import { ContextContainer } from "#context/container.js";
import {
  observeSessionActivity,
  projectSessionActivity,
} from "#execution/session-activity-projection.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import type { ActivitySnapshotV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const at = "2026-01-01T00:00:00.000Z";

function turnEvent(type: "turn.started" | "turn.completed", turnId = "turn-1"): MessageStreamEvent {
  return {
    data: { sequence: 0, turnId },
    meta: { at, id: `${type}:${turnId}` },
    type,
  };
}

function context(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ActivityObserverKey, {
    sink: {
      url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
      version: 1,
    },
  });
  return ctx;
}

function reduceProjection(input: {
  readonly events: readonly MessageStreamEvent[];
  readonly sessionId: string;
  /** The session state a `turn.cancelled` settles, as `settleCancelledTurnStep` reads it. */
  readonly cancelledState?: SessionStateMap;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): ActivitySnapshotV1 {
  const ctx = context();
  return input.events.reduce((snapshot, event) => {
    if (event.type === "turn.cancelled") {
      retainAnswerableActivityBlockers(ctx, input.cancelledState);
    }
    updateActivityState(ctx, event);
    return reduceActivityBatch(snapshot, {
      events: projectSessionActivity({
        event,
        sessionId: input.sessionId,
        suppressSettlement: ctx.has(ActivityPendingBlockersKey),
        workIdentity: input.workIdentity,
      }),
      version: 1,
    });
  }, createActivitySnapshot());
}

const delegatedWork: ActivityWorkIdentityV1 = {
  callId: "call-1",
  id: "work:parent:turn-1:call-1",
  kind: "subagent",
  name: "researcher",
  parentId: "root:parent:turn-1",
  rootSessionId: "parent",
  rootTurnId: "turn-1",
};
const questionBlockerId = `input:${delegatedWork.id}:request-1`;

function inputRequested(
  requestId: string,
  kind: "question" | "tool-approval",
  turnId = "child-turn",
): MessageStreamEvent {
  return {
    data: {
      requests: [
        {
          action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "search" },
          kind,
          prompt: "Which region?",
          requestId,
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId,
    },
    meta: { at, id: `input-requested:${requestId}` },
    type: "input.requested",
  };
}

const turnCancelled: MessageStreamEvent = {
  data: { sequence: 1, turnId: "child-turn" },
  meta: { at, id: "turn.cancelled:child-turn" },
  type: "turn.cancelled",
};

/** A delegated session whose running turn asked a question. */
const askedQuestion: readonly MessageStreamEvent[] = [
  { data: {}, meta: { at, id: "session-started" }, type: "session.started" },
  inputRequested("request-1", "question"),
];

/** The same session after its turn parked awaiting the answer. */
const parkedOnQuestion: readonly MessageStreamEvent[] = [
  ...askedQuestion,
  turnEvent("turn.completed", "child-turn"),
  {
    data: { continuationToken: "child-token", wait: "next-user-message" },
    meta: { at, id: "session-waiting" },
    type: "session.waiting",
  },
];

function projectDelegated(
  events: readonly MessageStreamEvent[],
  cancelledState?: SessionStateMap,
): ActivitySnapshotV1 {
  return reduceProjection({
    cancelledState,
    events,
    sessionId: "child-session",
    workIdentity: delegatedWork,
  });
}

describe("projectSessionActivity", () => {
  it("maps turn.started and turn.completed to root work lifecycle", () => {
    const sessionId = "session-1";
    const workId = deriveRootTurnActivityWorkId({ sessionId, turnId: "turn-1" });
    expect(
      [turnEvent("turn.started"), turnEvent("turn.completed")].flatMap((event) =>
        projectSessionActivity({ event, sessionId }),
      ),
    ).toEqual([
      {
        eventId: `${workId}:started`,
        kind: "work.started",
        startedAt: at,
        work: {
          id: workId,
          kind: "root-turn",
          rootSessionId: "session-1",
          rootTurnId: "turn-1",
          sessionId: "session-1",
          turnId: "turn-1",
        },
      },
      {
        eventId: `${workId}:settled:completed`,
        kind: "work.settled",
        outcome: "completed",
        settledAt: at,
        workId,
      },
    ]);
  });

  it("groups a resumed turn with its originating root work", () => {
    const sessionId = "session-1";
    const started = projectSessionActivity({
      event: turnEvent("turn.started", "turn-2"),
      rootTurnId: "turn-1",
      sessionId,
    });
    expect(started).toEqual([
      expect.objectContaining({
        kind: "work.started",
        work: expect.objectContaining({
          id: deriveRootTurnActivityWorkId({ sessionId, turnId: "turn-1" }),
          rootTurnId: "turn-1",
          turnId: "turn-2",
        }),
      }),
    ]);
  });

  it("keeps an originating root open while HITL or subagent work is pending", () => {
    const event = turnEvent("turn.completed", "turn-1");
    expect(
      projectSessionActivity({
        event,
        rootTurnId: "turn-1",
        sessionId: "session-1",
        suppressSettlement: true,
      }),
    ).toEqual([]);
  });

  it("reduces replayed root events to one completed work summary", () => {
    const sequence = [turnEvent("turn.started"), turnEvent("turn.completed")];
    const snapshot = reduceProjection({
      events: [...sequence, ...sequence],
      sessionId: "session-1",
    });

    const workId = deriveRootTurnActivityWorkId({ sessionId: "session-1", turnId: "turn-1" });
    expect(snapshot.work).toEqual({
      [workId]: expect.objectContaining({ id: workId, phase: "completed" }),
    });
    expect(snapshot.pendingSettlements).toEqual({});
  });

  it("keeps a task call running from its receipt until task.settled", () => {
    const ctx = context();
    const coordinates = { sequence: 0, stepIndex: 0, turnId: "turn-1" };
    const call = { callId: "call-1", taskId: "task-1", turnId: "turn-1" };
    const receipt: MessageStreamEvent = {
      data: {
        ...coordinates,
        result: { callId: "call-1", kind: "tool-result", output: "Started", toolName: "report" },
        status: "completed",
      },
      meta: { at, id: "receipt" },
      type: "action.result",
    };
    const settled: MessageStreamEvent = {
      data: { ...call, error: { message: "Source unavailable." }, status: "failed" },
      meta: { at, id: "task-settled" },
      type: "task.settled",
    };
    const events: MessageStreamEvent[] = [
      {
        data: {
          ...coordinates,
          actions: [{ callId: "call-1", input: {}, kind: "tool-call", toolName: "report" }],
        },
        meta: { at, id: "actions" },
        type: "actions.requested",
      },
      {
        data: { ...call, kind: "tool", name: "report" },
        meta: { at, id: "task-started" },
        type: "task.started",
      },
      receipt,
    ];
    const reduce = (snapshot: ActivitySnapshotV1, event: MessageStreamEvent) => {
      updateActivityState(ctx, event);
      return reduceActivityBatch(snapshot, {
        events: projectSessionActivity({
          event,
          sessionId: "session-1",
          taskCallIds: ctx.get(ActivityTaskCallsKey),
        }),
        version: 1,
      });
    };
    const actionId = `action:${deriveRootTurnActivityWorkId({ sessionId: "session-1", turnId: "turn-1" })}:call-1`;

    const afterReceipt = events.reduce(reduce, createActivitySnapshot());
    expect(afterReceipt.actions[actionId]).toMatchObject({ phase: "running" });

    const afterSettled = reduce(afterReceipt, settled);
    expect(afterSettled.actions[actionId]).toMatchObject({ phase: "failed" });
  });

  it("uses the durable partial event id for activity updates", () => {
    const event: MessageStreamEvent = {
      data: {
        presentation: { "tool-1": { label: "Collecting sources" } },
        result: {
          callId: "tool-1",
          kind: "tool-result",
          output: { phase: "Collecting" },
          toolName: "build_report",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
      meta: { at, id: "partial-1" },
      type: "action.partial",
    };

    expect(
      projectSessionActivity({
        event,
        sessionId: "session-1",
      }),
    ).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining(":update:partial-1"),
        kind: "action.label.updated",
        label: "Collecting sources",
      }),
    ]);
  });

  it("maps session and later turn starts to the active delegated work", () => {
    const first: ActivityWorkIdentityV1 = {
      callId: "call-1",
      id: "work:first",
      kind: "subagent",
      name: "researcher",
      rootSessionId: "parent",
      rootTurnId: "root-turn",
    };
    const second = { ...first, callId: "call-2", id: "work:second" };

    expect(
      projectSessionActivity({
        event: { data: {}, meta: { at, id: "session-started" }, type: "session.started" },
        sessionId: "child",
        workIdentity: first,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "work.started",
        work: expect.objectContaining({ id: first.id }),
      }),
    ]);
    expect(
      projectSessionActivity({
        event: turnEvent("turn.started", "child-turn-2"),
        sessionId: "child",
        workIdentity: second,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "work.started",
        work: expect.objectContaining({ id: second.id }),
      }),
    ]);
  });

  it("keeps delegated work open while its turn waits on a person, then settles it with the resumed turn", () => {
    const resumed: MessageStreamEvent[] = [
      {
        data: {
          resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }],
          sequence: 2,
          stepIndex: 0,
          turnId: "child-turn-2",
        },
        meta: { at, id: "input-resolved" },
        type: "input.resolved",
      },
      turnEvent("turn.started", "child-turn-2"),
      turnEvent("turn.completed", "child-turn-2"),
    ];

    const whileParked = projectDelegated(parkedOnQuestion);
    expect(whileParked.work[delegatedWork.id]).toMatchObject({ phase: "running" });
    expect(whileParked.blockers[questionBlockerId]).toMatchObject({ phase: "blocked" });

    expect(
      projectDelegated([...parkedOnQuestion, ...resumed]).work[delegatedWork.id],
    ).toMatchObject({ phase: "completed" });
  });

  it("settles work and its question when the turn waiting on the question is cancelled", () => {
    const snapshot = projectDelegated([...askedQuestion, turnCancelled]);

    expect(snapshot.work[delegatedWork.id]).toMatchObject({ phase: "cancelled" });
    expect(snapshot.blockers[questionBlockerId]).toMatchObject({ phase: "cancelled" });
  });

  it("keeps work open after a cancel while its own approval can still be answered", () => {
    const approval = inputRequested("approval-1", "tool-approval");
    const stillAwaitingApproval = appendPendingInputBatch({
      requests: approval.type === "input.requested" ? approval.data.requests : [],
      responseMessages: [],
      session: {} as HarnessSession,
    });

    const snapshot = projectDelegated(
      [...askedQuestion, approval, turnEvent("turn.completed", "child-turn"), turnCancelled],
      stillAwaitingApproval.state,
    );

    expect(snapshot.work[delegatedWork.id]).toMatchObject({ phase: "running" });
    expect(snapshot.blockers[`approval:${delegatedWork.id}:approval-1`]).toMatchObject({
      phase: "blocked",
    });
  });
});

describe("observeSessionActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not submit events with no activity projection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const event: MessageStreamEvent = {
      data: {
        messageDelta: "hello",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
      meta: { at, id: "message" },
      type: "message.appended",
    };

    await observeSessionActivity({ ctx: context(), event, sessionId: "session-1" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits projected activity and swallows transport failure", async () => {
    const logs = captureLogRecords();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      observeSessionActivity({
        ctx: context(),
        event: turnEvent("turn.started"),
        sessionId: "session-1",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "activity sink request failed" }),
    );
  });
});
