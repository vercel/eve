import { describe, expect, it } from "vitest";

import { closedTaskCard, nextSegment, taskCardView, workingTaskNames } from "#channel/task-card.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { JsonValue } from "#shared/json.js";

const turnId = "turn_0";
const scope = { runId: "run_0", turnId };

/** Folds each commit as the server does, with operational retention, so cards read what it keeps. */
function serverView(commits: readonly (readonly SessionEvent[])[]): SessionView {
  const view = emptySessionView();
  commits.forEach((facts, position) =>
    foldLine(view, { at: `2026-10-13T00:00:0${position}.000Z`, facts }, position, {
      retention: "operational",
    }),
  );
  return view;
}

const opening: SessionEvent[][] = [
  [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
  ],
  [
    { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
    { data: { deliveryId: "d_0", parts: [], turnId }, type: "delivery.consumed" },
    { data: { owner: { turnId }, runId: "run_0" }, scope, type: "model.requested" },
  ],
];

function requested(callId: string, name: string, kind: "agent" | "tool" = "tool"): SessionEvent {
  return {
    data: { callId, capability: { kind, name }, input: { q: callId }, owner: { runId: "run_0" } },
    scope,
    type: "call.requested",
  };
}

function startsTask(callId: string, taskId: string, name: string): SessionEvent[] {
  return [
    { data: { kind: "agent", name, startedBy: { callId }, taskId }, type: "task.started" },
    { data: { callId, taskId }, scope, type: "call.started" },
  ];
}

const settled = (callId: string, output: JsonValue): SessionEvent => ({
  data: { callId, outcome: "completed", output },
  scope,
  type: "call.settled",
});

describe("task cards read from the server's tables", () => {
  it("shows a turn's tasks and actions, a task's request, and how each ended", () => {
    const working = serverView([
      ...opening,
      [requested("plan", "plan"), requested("research", "researcher", "agent")],
      [...startsTask("research", "t_1", "researcher"), settled("plan", { steps: [] })],
      [
        { data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" },
        {
          data: {
            interactionId: "ask_1",
            request: { kind: "question", prompt: "Which region?" },
            subject: { taskId: "t_1" },
          },
          type: "interaction.opened",
        },
      ],
    ]);
    const card = taskCardView(working, turnId, { audience: "private" });
    expect(card.state).toBe("blocked");
    expect(card.actions.map((action) => [action.id, action.status])).toEqual([
      ["plan", "completed"],
    ]);
    expect(card.tasks[0]).toMatchObject({
      blockedOn: { kind: "input", label: "Which region?" },
      id: "research",
      kind: "agent",
      status: "blocked",
      taskId: "t_1",
    });
    expect(taskCardView(working, turnId, { audience: "public" }).tasks[0]?.blockedOn).toEqual({
      kind: "input",
    });
    expect(workingTaskNames(working, turnId)).toEqual(["researcher"]);

    // The turn settles while its task works; the card keeps its rows until the task ends.
    const finished = serverView([
      ...opening,
      [requested("plan", "plan"), requested("research", "researcher", "agent")],
      [...startsTask("research", "t_1", "researcher"), settled("plan", { steps: [] })],
      [{ data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" }],
      [{ data: { outcome: "completed", turnId }, type: "turn.settled" }],
      [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }],
      [settled("research", { message: "Use us-east. It is closest." })],
      [{ data: { outcome: "completed", taskId: "t_1" }, type: "task.ended" }],
    ]);
    const done = taskCardView(finished, turnId, { audience: "private" });
    expect(done.state).toBe("finished");
    expect(done.actions.map((action) => action.id)).toEqual(["plan"]);
    expect(done.tasks[0]).toMatchObject({ status: "completed", summary: "Use us-east." });
    expect(done.tasks[0]?.settledAt).toBe("2026-10-13T00:00:07.000Z");
  });

  it("ends a card whose tasks all settled when the turn starts another, carrying working calls", () => {
    const view = serverView([
      ...opening,
      [requested("first", "researcher", "agent"), requested("watch", "watch")],
      [...startsTask("first", "t_1", "researcher")],
      [settled("first", "Found it.")],
      [requested("second", "researcher", "agent")],
      [...startsTask("second", "t_2", "researcher")],
    ]);
    const card = taskCardView(view, turnId, { audience: "private" });
    const closed = closedTaskCard({
      ...card,
      actions: card.actions,
      tasks: card.tasks.filter((task) => task.id !== "second"),
    });
    expect(closed?.state).toBe("finished");
    expect(closed?.tasks.map((task) => task.id)).toEqual(["first"]);
    expect(closed?.actions).toEqual([]);

    const segment = nextSegment(view, turnId, "second");
    expect(segment.carried).toEqual(["watch"]);
    const next = taskCardView(view, turnId, { audience: "private", segment });
    expect(next.tasks.map((task) => task.id)).toEqual(["second"]);
    expect(next.actions.map((action) => action.id)).toEqual(["watch"]);
  });
});
