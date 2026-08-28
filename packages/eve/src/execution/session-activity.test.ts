import { describe, expect, it } from "vitest";

import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { parseActivityBatchV1, type ActivityEventV1 } from "#protocol/activity.js";

const work = {
  id: "root:session:turn",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};

function reduce(events: readonly ActivityEventV1[]) {
  return reduceActivityBatch(createActivitySnapshot(), { events, version: 1 });
}

describe("activity protocol and reducer", () => {
  it("retains known siblings while ignoring additive unknown events", () => {
    expect(
      parseActivityBatchV1({
        events: [
          { eventId: "future", kind: "detail.updated", message: "working" },
          { eventId: "started", kind: "work.started", startedAt: "2026-01-01", work },
        ],
        version: 1,
      }),
    ).toEqual({
      events: [{ eventId: "started", kind: "work.started", startedAt: "2026-01-01", work }],
      version: 1,
    });
  });

  it("rejects malformed known events", () => {
    expect(
      parseActivityBatchV1({
        events: [{ eventId: "started", kind: "work.started", work }],
        version: 1,
      }),
    ).toBeUndefined();
    expect(
      parseActivityBatchV1({
        events: [{ eventId: "updated", kind: "work.updated", message: "Working", workId: work.id }],
        version: 1,
      }),
    ).toBeUndefined();
    expect(
      parseActivityBatchV1({
        events: [{ actionId: "action", eventId: "updated", kind: "action.updated" }],
        version: 1,
      }),
    ).toBeUndefined();
  });

  it("deduplicates only by event id", () => {
    const event = { eventId: "started", kind: "work.started" as const, startedAt: "now", work };
    const first = reduce([event]);
    const duplicate = reduceActivityBatch(first, { events: [event], version: 1 });
    expect(duplicate).toBe(first);
  });

  it("retains the latest normalized milestone while work is running", () => {
    const snapshot = reduce([
      { eventId: "started", kind: "work.started", startedAt: "1", work },
      {
        eventId: "updated-1",
        kind: "work.updated",
        message: "Comparing\u0007   the renderer",
        updatedAt: "2",
        workId: work.id,
      },
      {
        eventId: "updated-2",
        kind: "work.updated",
        message: "Validating the projection",
        updatedAt: "3",
        workId: work.id,
      },
    ]);

    expect(snapshot.work[work.id]).toMatchObject({
      update: { message: "Validating the projection", updatedAt: "3" },
    });
  });

  it("retains a milestone that arrives before work starts", () => {
    const snapshot = reduce([
      {
        eventId: "updated",
        kind: "work.updated",
        message: "Comparing the renderer",
        updatedAt: "2",
        workId: work.id,
      },
      { eventId: "started", kind: "work.started", startedAt: "1", work },
    ]);

    expect(snapshot.work[work.id]).toMatchObject({
      update: { message: "Comparing the renderer", updatedAt: "2" },
    });
    expect(snapshot.pendingWorkUpdates).toEqual({});
  });

  it.each([
    ["newer before older", ["started", "newer", "older"]],
    ["settlement before updates", ["started", "settled", "newer", "older"]],
  ] as const)("converges work updates for %s delivery", (_name, order) => {
    const events: Record<string, ActivityEventV1> = {
      started: { eventId: "started", kind: "work.started", startedAt: "1", work },
      older: {
        eventId: "updated-1",
        kind: "work.updated",
        message: "Older update",
        updatedAt: "2",
        workId: work.id,
      },
      newer: {
        eventId: "updated-2",
        kind: "work.updated",
        message: "Newer update",
        updatedAt: "3",
        workId: work.id,
      },
      settled: {
        eventId: "settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "4",
        workId: work.id,
      },
    };

    const snapshot = reduce(order.map((key) => events[key]!));

    expect(snapshot.work[work.id]?.update).toEqual({
      eventId: "updated-2",
      message: "Newer update",
      updatedAt: "3",
    });
  });

  it.each([
    ["newer before older", ["work", "action", "newer", "older"]],
    ["settlement before updates", ["work", "action", "settled", "newer", "older"]],
  ] as const)("converges action updates for %s delivery", (_name, order) => {
    const action = {
      id: "action",
      kind: "tool" as const,
      name: "deploy",
      parentWorkId: work.id,
      rootTurnId: "turn",
      stepIndex: 0,
    };
    const events: Record<string, ActivityEventV1> = {
      work: { eventId: "work", kind: "work.started", startedAt: "1", work },
      action: { action, eventId: "action", kind: "action.started", startedAt: "2" },
      older: {
        actionId: action.id,
        eventId: "updated-1",
        kind: "action.updated",
        message: "Older update",
        updatedAt: "3",
      },
      newer: {
        actionId: action.id,
        eventId: "updated-2",
        kind: "action.updated",
        message: "Newer update",
        updatedAt: "4",
      },
      settled: {
        actionId: action.id,
        eventId: "settled-action",
        kind: "action.settled",
        outcome: "completed",
        settledAt: "5",
      },
    };

    const snapshot = reduce(order.map((key) => events[key]!));

    expect(snapshot.actions.action?.update).toEqual({
      eventId: "updated-2",
      message: "Newer update",
      updatedAt: "4",
    });
  });

  it("retains an action update that arrives before action startup", () => {
    const action = {
      id: "action",
      kind: "tool" as const,
      name: "deploy",
      parentWorkId: work.id,
      rootTurnId: "turn",
      stepIndex: 0,
    };
    const snapshot = reduce([
      {
        actionId: action.id,
        eventId: "updated",
        kind: "action.updated",
        message: "Uploading artifacts",
        updatedAt: "3",
      },
      { eventId: "work", kind: "work.started", startedAt: "1", work },
      { action, eventId: "action", kind: "action.started", startedAt: "2" },
    ]);

    expect(snapshot.actions.action?.update).toEqual({
      eventId: "updated",
      message: "Uploading artifacts",
      updatedAt: "3",
    });
    expect(snapshot.pendingActionUpdates).toEqual({});
  });

  it("applies settlement before start and never reopens terminal work", () => {
    const settled = reduce([
      {
        eventId: "settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "later",
        workId: work.id,
      },
    ]);
    const started = reduceActivityBatch(settled, {
      events: [{ eventId: "started", kind: "work.started", startedAt: "earlier", work }],
      version: 1,
    });
    const duplicateStart = reduceActivityBatch(started, {
      events: [{ eventId: "started-again", kind: "work.started", startedAt: "latest", work }],
      version: 1,
    });
    expect(started.work[work.id]?.phase).toBe("completed");
    expect(duplicateStart.work[work.id]).toBe(started.work[work.id]);
  });

  it.each([
    ["child before parent", ["child", "root-settled", "root"]],
    ["parent before child", ["root-settled", "root", "child"]],
    ["ordered", ["root", "child", "root-settled"]],
  ] as const)("converges work settlement for %s delivery", (_name, order) => {
    const child = {
      id: "work:child",
      kind: "subagent" as const,
      parentId: work.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const events: Record<string, ActivityEventV1> = {
      root: { eventId: "root", kind: "work.started", startedAt: "1", work },
      child: { eventId: "child", kind: "work.started", startedAt: "2", work: child },
      "root-settled": {
        eventId: "root-settled",
        kind: "work.settled",
        outcome: "failed",
        settledAt: "3",
        workId: work.id,
      },
    };

    const snapshot = reduce(order.map((key) => events[key]!));

    expect(snapshot.work[work.id]?.phase).toBe("failed");
    expect(snapshot.work[child.id]?.phase).toBe("cancelled");
    expect(snapshot.pendingSettlements).toEqual({});
  });

  it("cancels early actions and blockers when their parent starts terminal", () => {
    const snapshot = reduce([
      {
        action: {
          id: "action",
          kind: "tool",
          name: "search",
          parentWorkId: work.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "action",
        kind: "action.started",
        startedAt: "1",
      },
      {
        blocker: {
          id: "input",
          kind: "input",
          parentWorkId: work.id,
          rootTurnId: "turn",
        },
        eventId: "input",
        kind: "blocker.started",
        startedAt: "1",
      },
      {
        eventId: "settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "2",
        workId: work.id,
      },
      { eventId: "root", kind: "work.started", startedAt: "0", work },
    ]);

    expect(snapshot.work[work.id]?.phase).toBe("completed");
    expect(snapshot.actions.action?.phase).toBe("cancelled");
    expect(snapshot.blockers.input?.phase).toBe("cancelled");
  });

  it("retains unmatched settlement without changing revision", () => {
    const initial = createActivitySnapshot();
    const next = reduceActivityBatch(initial, {
      events: [
        {
          blockerId: "authorization:work:attempt",
          eventId: "settled",
          kind: "blocker.settled",
          outcome: "completed",
          settledAt: "now",
        },
      ],
      version: 1,
    });
    expect(next.revision).toBe(0);
    expect(next.pendingSettlements).toHaveProperty("blocker:authorization:work:attempt");
  });

  it("recursively cancels active descendant work and its owned entities", () => {
    const child = {
      id: "work:child",
      kind: "subagent" as const,
      parentId: work.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const grandchild = {
      id: "work:grandchild",
      kind: "subagent" as const,
      parentId: child.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const snapshot = reduce([
      { eventId: "root", kind: "work.started", startedAt: "1", work },
      { eventId: "child", kind: "work.started", startedAt: "2", work: child },
      { eventId: "grandchild", kind: "work.started", startedAt: "3", work: grandchild },
      {
        action: {
          id: "grandchild-action",
          kind: "tool",
          name: "search",
          parentWorkId: grandchild.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "grandchild-action",
        kind: "action.started",
        startedAt: "4",
      },
      {
        blocker: {
          id: "child-input",
          kind: "input",
          parentWorkId: child.id,
          rootTurnId: "turn",
        },
        eventId: "child-input",
        kind: "blocker.started",
        startedAt: "5",
      },
      {
        eventId: "root-settled",
        kind: "work.settled",
        outcome: "failed",
        settledAt: "6",
        workId: work.id,
      },
    ]);

    expect(snapshot.work[work.id]?.phase).toBe("failed");
    expect(snapshot.work[child.id]?.phase).toBe("cancelled");
    expect(snapshot.work[grandchild.id]?.phase).toBe("cancelled");
    expect(snapshot.actions["grandchild-action"]?.phase).toBe("cancelled");
    expect(snapshot.blockers["child-input"]?.phase).toBe("cancelled");
  });

  it("cancels running owned actions and blockers when work settles", () => {
    const snapshot = reduce([
      { eventId: "work", kind: "work.started", startedAt: "1", work },
      {
        action: {
          id: "action",
          kind: "tool",
          name: "search",
          parentWorkId: work.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "action",
        kind: "action.started",
        startedAt: "2",
      },
      {
        blocker: {
          id: "input",
          kind: "input",
          parentWorkId: work.id,
          rootTurnId: "turn",
        },
        eventId: "input",
        kind: "blocker.started",
        startedAt: "3",
      },
      {
        eventId: "settled",
        kind: "work.settled",
        outcome: "failed",
        settledAt: "4",
        workId: work.id,
      },
    ]);
    expect(snapshot.actions.action?.phase).toBe("cancelled");
    expect(snapshot.blockers.input?.phase).toBe("cancelled");
  });
});
