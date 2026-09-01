import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityObserverKey, TurnTaskDeliveryKey } from "#context/keys.js";
import { ContextContainer } from "#context/container.js";
import {
  observeSessionActivity,
  projectSessionActivity,
} from "#execution/session-activity-projection.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import type { ActivitySnapshotV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const at = "2026-01-01T00:00:00.000Z";

function turnEvent(type: "turn.started" | "turn.completed", turnId = "turn-1"): MessageStreamEvent {
  return {
    data: { sequence: 0, turnId },
    meta: { at, id: `${type}:${turnId}` },
    type,
  };
}

function reduceProjection(input: {
  readonly events: readonly MessageStreamEvent[];
  readonly sessionId: string;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): ActivitySnapshotV1 {
  return input.events.reduce(
    (snapshot, event) =>
      reduceActivityBatch(snapshot, {
        events: projectSessionActivity({
          event,
          sessionId: input.sessionId,
          workIdentity: input.workIdentity,
        }),
        version: 1,
      }),
    createActivitySnapshot(),
  );
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

  it("uses the durable partial event id for activity updates", () => {
    const event: MessageStreamEvent = {
      data: {
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
        activityLabels: { "tool-1": "Collecting sources" },
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

  it("maps session.started to delegated work start and keeps HITL active while parked", () => {
    const workIdentity: ActivityWorkIdentityV1 = {
      callId: "call-1",
      id: "work:parent:turn-1:call-1",
      kind: "subagent",
      name: "researcher",
      parentId: "root:parent:turn-1",
      rootSessionId: "parent",
      rootTurnId: "turn-1",
    };
    const snapshot = reduceProjection({
      events: [
        { data: {}, meta: { at, id: "session-started" }, type: "session.started" },
        {
          data: {
            requests: [
              {
                action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "search" },
                kind: "question",
                prompt: "Which region?",
                requestId: "request-1",
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "child-turn",
          },
          meta: { at, id: "input-requested" },
          type: "input.requested",
        },
        turnEvent("turn.completed", "child-turn"),
        {
          data: { continuationToken: "child-token", wait: "next-user-message" },
          meta: { at, id: "session-waiting" },
          type: "session.waiting",
        },
      ],
      sessionId: "child-session",
      workIdentity,
    });

    expect(snapshot.work[workIdentity.id]).toMatchObject({ phase: "running" });
    expect(snapshot.blockers[`input:${workIdentity.id}:request-1`]).toMatchObject({
      phase: "blocked",
    });
  });
});

describe("observeSessionActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  function context(taskDelivery?: "none" | "initiating" | "pending" | "settled"): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(ActivityObserverKey, {
      sink: {
        url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
        version: 1,
      },
    });
    if (taskDelivery !== undefined) ctx.set(TurnTaskDeliveryKey, taskDelivery);
    return ctx;
  }

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

  it("does not project internal background-task delivery turns as new root work", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const taskDelivery of ["pending", "settled"] as const) {
      await observeSessionActivity({
        ctx: context(taskDelivery),
        event: turnEvent("turn.started", `turn-${taskDelivery}`),
        sessionId: "session-1",
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps projecting the turn that initiates background tasks", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await observeSessionActivity({
      ctx: context("initiating"),
      event: turnEvent("turn.started"),
      sessionId: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("submits projected activity and swallows transport failure", async () => {
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
  });
});
