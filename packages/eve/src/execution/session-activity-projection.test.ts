import { describe, expect, it } from "vitest";

import { projectSessionActivity } from "#execution/session-activity-projection.js";
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
