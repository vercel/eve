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

  it("applies additive action labels without changing the action start shape", () => {
    const batch = parseActivityBatchV1({
      events: [
        {
          action: {
            id: "action",
            kind: "tool",
            name: "search",
            parentWorkId: work.id,
            rootTurnId: "turn",
            stepIndex: 0,
          },
          eventId: "action:start",
          kind: "action.started",
          startedAt: "now",
        },
        {
          actionId: "action",
          eventId: "action:label",
          kind: "action.label.updated",
          label: "Search issues",
        },
      ],
      version: 1,
    });

    expect(batch).toBeDefined();
    expect(reduceActivityBatch(createActivitySnapshot(), batch!).actions.action?.label).toBe(
      "Search issues",
    );
  });

  it("rejects malformed known events", () => {
    expect(
      parseActivityBatchV1({
        events: [{ eventId: "started", kind: "work.started", work }],
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

  it("keeps background task subtrees active when their initiating turn settles", () => {
    const task = {
      callId: "call-task",
      id: "work:task",
      kind: "subagent" as const,
      parentId: work.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const child = {
      id: "work:task-child",
      kind: "subagent" as const,
      parentId: task.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const snapshot = reduce([
      { eventId: "root", kind: "work.started", startedAt: "1", work },
      {
        action: {
          id: `action:${work.id}:call-task`,
          kind: "tool",
          name: "researcher",
          parentWorkId: work.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "task-action",
        kind: "action.started",
        startedAt: "2",
      },
      { eventId: "task", kind: "work.started", startedAt: "2", work: task },
      { eventId: "task-child", kind: "work.started", startedAt: "3", work: child },
      {
        eventId: "root-settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "4",
        workId: work.id,
      },
    ]);

    expect(snapshot.work[work.id]?.phase).toBe("completed");
    expect(snapshot.work[task.id]?.phase).toBe("running");
    expect(snapshot.work[child.id]?.phase).toBe("running");
  });

  it("starts background task work even when its parent turn already settled", () => {
    const task = {
      callId: "call-task",
      id: "work:task",
      kind: "subagent" as const,
      parentId: work.id,
      rootSessionId: "session",
      rootTurnId: "turn",
    };
    const snapshot = reduce([
      { eventId: "root", kind: "work.started", startedAt: "1", work },
      {
        action: {
          id: `action:${work.id}:call-task`,
          kind: "tool",
          name: "researcher",
          parentWorkId: work.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "task-action",
        kind: "action.started",
        startedAt: "1",
      },
      {
        eventId: "root-settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "2",
        workId: work.id,
      },
      { eventId: "task", kind: "work.started", startedAt: "3", work: task },
    ]);

    expect(snapshot.work[task.id]?.phase).toBe("running");
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
